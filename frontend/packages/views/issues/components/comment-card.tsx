"use client";

import { memo, useCallback, useRef, useState } from "react";
import { CheckCircle2, Copy, MoreHorizontal, Pencil, Reply, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multiremi/ui/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { ActorAvatar } from "../../common/actor-avatar";
import { ReactionBar } from "@multiremi/ui/components/common/reaction-bar";
import { QuickEmojiPicker } from "@multiremi/ui/components/common/quick-emoji-picker";
import { cn } from "@multiremi/ui/lib/utils";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useTimeAgo } from "../../i18n";
import { ContentEditor, type ContentEditorRef, ReadonlyContent, useFileDropZone, FileDropOverlay, Attachment as AttachmentRenderer, AttachmentDownloadProvider } from "../../editor";
import { FileUploadButton } from "@multiremi/ui/components/common/file-upload-button";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { api } from "@multiremi/core/api";
import type { ReplyTarget } from "./comment-input";
import { quotePreview } from "../utils/quote-preview";
import type { TimelineEntry, Attachment } from "@multiremi/core/types";
import { useCommentDraftStore } from "@multiremi/core/issues/stores";
import { useT } from "../../i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The comment this one replies to, resolved by `issue-detail.tsx` from the
 * same timeline array. Objects are memoized per comment id so passing one
 * here does not bust the card's `React.memo`.
 */
interface CommentParentRef {
  id: string;
  actorType: string;
  actorId: string;
  /** Opening slice of the parent body, markdown stripped (see `quotePreview`). */
  preview: string;
}

interface CommentCardProps {
  issueId: string;
  entry: TimelineEntry;
  /**
   * Set when this comment has a `parent_id` that resolves inside the loaded
   * timeline. Renders the reference chip; absent for a comment that starts
   * its own thread (and for a reply whose parent fell outside the window).
   */
  parentRef?: CommentParentRef;
  /** Scrolls to + briefly highlights the parent entry. */
  onNavigateToParent?: (parentId: string) => void;
  /** True when some other comment in the session points at this one — the
   * delete dialog has to warn that the cascade takes them too. */
  hasReplies?: boolean;
  currentUserId?: string;
  /**
   * True when the current user is a workspace owner/admin and can therefore
   * moderate comments authored by anyone — restoring the admin override that
   * the backend already grants at `comment.go:507-512`. Computed once in
   * `issue-detail.tsx` and threaded down so this component doesn't rerun the
   * rule per row.
   */
  canModerate?: boolean;
  /**
   * Points the session's single composer at this message. There is no
   * per-message input any more — replying is a context the bottom composer
   * carries until it sends or the user clears it.
   */
  onStartReply: (target: ReplyTarget) => void;
  onEdit: (commentId: string, content: string, attachmentIds: string[]) => Promise<void>;
  onDelete: (commentId: string) => void;
  onToggleReaction: (commentId: string, emoji: string) => void;
  /** Toggle the resolved state on this comment. */
  onResolveToggle?: (commentId: string, resolved: boolean) => void;
  /**
   * When non-null, this comment is currently a resolved-but-expanded row.
   * Renders a "Collapse" affordance above it so the user can fold it back to
   * the bar; the parent owns the session state.
   */
  onCollapseResolved?: () => void;
  /** ID of the comment to highlight (flash animation). */
  highlightedCommentId?: string | null;
}

// ---------------------------------------------------------------------------
// Shared delete confirmation dialog
// ---------------------------------------------------------------------------

function DeleteCommentDialog({
  open,
  onOpenChange,
  onConfirm,
  hasReplies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  hasReplies?: boolean;
}) {
  const { t } = useT("issues");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.comment.delete_title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {hasReplies
              ? t(($) => $.comment.delete_desc_with_replies)
              : t(($) => $.comment.delete_desc)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t(($) => $.comment.cancel_action)}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {t(($) => $.comment.delete_action)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Standalone attachment list — renders attachments not already in the markdown
// ---------------------------------------------------------------------------

export function AttachmentList({
  attachments,
  content,
  className,
  onRemove,
}: {
  attachments?: Attachment[];
  content?: string;
  className?: string;
  onRemove?: (attachmentId: string) => void;
}) {
  if (!attachments?.length) return null;
  // Skip attachments whose URL is already referenced in the markdown content,
  // and duplicates of the same file (same name/type/size) that are referenced.
  const standalone = content
    ? attachments.filter((a) => {
        if (content.includes(a.url)) return false;
        // Dedup: if another attachment with the same file identity is already
        // inline in the content, this is a duplicate upload — skip it.
        const hasSiblingInContent = attachments.some(
          (other) =>
            other.id !== a.id &&
            other.filename === a.filename &&
            other.content_type === a.content_type &&
            other.size_bytes === a.size_bytes &&
            content.includes(other.url),
        );
        if (hasSiblingInContent) return false;
        return true;
      })
    : attachments;
  if (!standalone.length) return null;

  return (
    <AttachmentDownloadProvider attachments={attachments}>
      <div className={cn("flex flex-col gap-1", className)}>
        {standalone.map((a) => (
          <AttachmentRenderer
            key={a.id}
            attachment={{ kind: "record", attachment: a }}
            editable={!!onRemove}
            onDelete={onRemove ? () => onRemove(a.id) : undefined}
          />
        ))}
      </div>
    </AttachmentDownloadProvider>
  );
}

function collectActiveAttachmentIds(
  content: string,
  attachments: Attachment[],
  retainedStandaloneIds?: Set<string> | null,
): string[] {
  const ids = new Set<string>();
  for (const attachment of attachments) {
    if (content.includes(attachment.url)) ids.add(attachment.id);
  }
  for (const id of retainedStandaloneIds ?? []) ids.add(id);
  return [...ids];
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function initialStandaloneAttachmentIds(entry: TimelineEntry): Set<string> {
  const content = entry.content ?? "";
  return new Set(
    (entry.attachments ?? [])
      .filter((attachment) => !content.includes(attachment.url))
      .map((attachment) => attachment.id),
  );
}

// ---------------------------------------------------------------------------
// Shared edit-attachment state hook
// ---------------------------------------------------------------------------

function useEditAttachmentState(
  issueId: string,
  entry: TimelineEntry,
  onEdit: (commentId: string, content: string, attachmentIds: string[]) => Promise<void>,
) {
  const { t } = useT("issues");
  const { uploadWithToast } = useFileUpload(api);
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<ContentEditorRef>(null);
  const cancelledRef = useRef(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [retainedStandaloneIds, setRetainedStandaloneIds] = useState<Set<string> | null>(null);

  const editorAttachments = pendingAttachments.length > 0
    ? [...(entry.attachments ?? []), ...pendingAttachments]
    : entry.attachments;

  const handleUpload = useCallback(async (file: File) => {
    const result = await uploadWithToast(file, { issueId });
    if (result) setPendingAttachments((prev) => [...prev, result]);
    return result;
  }, [uploadWithToast, issueId]);

  const { isDragOver, dropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => editorRef.current?.uploadFile(f)),
    enabled: editing,
  });

  const draftKey = `edit:${issueId}:${entry.id}` as const;
  const getDraft = useCommentDraftStore.getState().getDraft;
  const setDraft = useCommentDraftStore((s) => s.setDraft);
  const clearDraft = useCommentDraftStore((s) => s.clearDraft);

  const initialValue = editing
    ? (getDraft(draftKey) ?? entry.content ?? "")
    : (entry.content ?? "");

  const standaloneEditAttachments = (entry.attachments ?? []).filter((a) =>
    retainedStandaloneIds?.has(a.id),
  );

  const resetState = () => {
    setEditing(false);
    setPendingAttachments([]);
    setRetainedStandaloneIds(null);
    clearDraft(draftKey);
  };

  const startEdit = () => {
    cancelledRef.current = false;
    setRetainedStandaloneIds(initialStandaloneAttachmentIds(entry));
    setEditing(true);
  };

  const cancelEdit = () => {
    cancelledRef.current = true;
    resetState();
  };

  const saveEdit = async () => {
    if (cancelledRef.current) return;
    const trimmed = editorRef.current
      ?.getMarkdown()
      ?.replace(/(\n\s*)+$/, "")
      .trim();
    if (!trimmed) return;
    const activeIds = collectActiveAttachmentIds(
      trimmed,
      [...(entry.attachments ?? []), ...pendingAttachments],
      retainedStandaloneIds,
    );
    const attachmentsChanged = !sameIdSet(activeIds, (entry.attachments ?? []).map((a) => a.id));
    if (trimmed === (entry.content ?? "").trim() && !attachmentsChanged) {
      resetState();
      return;
    }
    try {
      await onEdit(entry.id, trimmed, activeIds);
      resetState();
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.comment.update_failed),
      );
    }
  };

  return {
    editing,
    editorRef,
    editorAttachments,
    handleUpload,
    isDragOver,
    dropZoneProps,
    draftKey,
    setDraft,
    clearDraft,
    initialValue,
    standaloneEditAttachments,
    retainedStandaloneIds,
    setRetainedStandaloneIds,
    startEdit,
    cancelEdit,
    saveEdit,
  };
}

// ---------------------------------------------------------------------------
// ParentQuoteLine — the only trace threading leaves in the flat stream
// ---------------------------------------------------------------------------

// A reply is an ordinary entry in the session's chronological stream; nothing
// nests it under its parent any more. This quote line is what keeps the link
// legible — one muted line behind a quote rule that names who is being
// answered, quotes the opening of what they said, and jumps to that entry on
// click. The preview is plain text (`quotePreview`): raw markdown here would
// spend the char budget on link targets instead of words.
function ParentQuoteLine({
  parentRef,
  onNavigate,
}: {
  parentRef: CommentParentRef;
  onNavigate?: (parentId: string) => void;
}) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();

  return (
    <button
      type="button"
      onClick={() => onNavigate?.(parentRef.id)}
      className="mb-1 flex w-full min-w-0 items-center gap-1 border-l-2 border-border py-0.5 pl-2 text-left text-xs text-muted-foreground transition-colors hover:border-brand/40 hover:text-foreground"
    >
      <Reply className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {t(($) => $.comment.parent_ref, {
          author: getActorName(parentRef.actorType, parentRef.actorId),
          preview: parentRef.preview,
        })}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CommentCard — one message row per comment, root and reply alike
// ---------------------------------------------------------------------------

function CommentCardImpl({
  issueId,
  entry,
  parentRef,
  onNavigateToParent,
  hasReplies,
  currentUserId,
  canModerate = false,
  onStartReply,
  onEdit,
  onDelete,
  onToggleReaction,
  onResolveToggle,
  onCollapseResolved,
  highlightedCommentId,
}: CommentCardProps) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const { getActorName } = useActorName();
  // Touch has no hover, so a hover-only toolbar is unreachable there. The
  // media query below covers touch at desktop widths; this covers the phone
  // layout, where the row is too narrow to leave the toolbar floating.
  const isMobile = useIsMobile();

  const edit = useEditAttachmentState(issueId, entry, onEdit);

  const isOwn = entry.actor_type === "member" && entry.actor_id === currentUserId;
  const canEditEntry = isOwn || (canModerate && entry.actor_type === "member");
  const canDeleteEntry = isOwn || canModerate;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const authorLabel = getActorName(entry.actor_type, entry.actor_id);
  const reactions = entry.reactions ?? [];
  const contentText = entry.content ?? "";
  const isLongContent = contentText.length > 500 || contentText.split("\n").length > 8;

  const isHighlighted = highlightedCommentId === entry.id;

  return (
    <div
      className={cn(
        "group/msg relative -mx-2 rounded-md px-2 py-1.5 transition-colors duration-700 hover:bg-muted/30",
        isHighlighted && "bg-brand/5 ring-1 ring-brand/40",
      )}
    >
      {onCollapseResolved && (
        <button
          type="button"
          onClick={onCollapseResolved}
          className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          {t(($) => $.comment.resolve.collapse)}
        </button>
      )}
      {parentRef && (
        <ParentQuoteLine parentRef={parentRef} onNavigate={onNavigateToParent} />
      )}

      {/* Header line — who spoke, and when. */}
      <div className="flex items-center gap-2">
        <ActorAvatar actorType={entry.actor_type} actorId={entry.actor_id} size={24} enableHoverCard showStatusDot />
        <span className="shrink-0 cursor-pointer text-sm font-medium">
          {authorLabel}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="shrink-0 text-xs text-muted-foreground cursor-default">
                {timeAgo(entry.created_at)}
              </span>
            }
          />
          <TooltipContent side="top">
            {new Date(entry.created_at).toLocaleString()}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Body — indented to the header's text column (24px avatar + gap-2). */}
      <div className="pl-8">
        {edit.editing ? (
          <div
            {...edit.dropZoneProps}
            className="relative"
            onKeyDown={(e) => { if (e.key === "Escape") edit.cancelEdit(); }}
          >
            <div className="text-sm leading-relaxed">
              <ContentEditor
                ref={edit.editorRef}
                defaultValue={edit.initialValue}
                placeholder={t(($) => $.comment.edit_placeholder)}
                onUpdate={(md) => {
                  if (md.trim().length > 0) edit.setDraft(edit.draftKey, md);
                  else edit.clearDraft(edit.draftKey);
                }}
                onSubmit={edit.saveEdit}
                onUploadFile={edit.handleUpload}
                debounceMs={100}
                currentIssueId={issueId}
                attachments={edit.editorAttachments}
              />
            </div>
            <div className="flex items-center justify-between mt-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {edit.standaloneEditAttachments.length > 0 && (
                  <AttachmentList
                    attachments={edit.standaloneEditAttachments}
                    className="max-w-full"
                    onRemove={(attachmentId) =>
                      edit.setRetainedStandaloneIds((ids) => {
                        const next = new Set(ids ?? []);
                        next.delete(attachmentId);
                        return next;
                      })
                    }
                  />
                )}
                <FileUploadButton
                  size="sm"
                  multiple
                  onSelect={(file) => edit.editorRef.current?.uploadFile(file)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={edit.cancelEdit}>{t(($) => $.comment.cancel_edit)}</Button>
                <Button size="sm" variant="outline" onClick={edit.saveEdit}>{t(($) => $.comment.save_action)}</Button>
              </div>
            </div>
            {edit.isDragOver && <FileDropOverlay />}
          </div>
        ) : (
          <>
            <div className="text-sm leading-relaxed text-foreground/85">
              <ReadonlyContent content={entry.content ?? ""} attachments={entry.attachments} />
            </div>
            <AttachmentList attachments={entry.attachments} content={entry.content} className="mt-1.5" />
            <ReactionBar
              reactions={reactions}
              currentUserId={currentUserId}
              onToggle={(emoji) => onToggleReaction(entry.id, emoji)}
              getActorName={getActorName}
              // The row toolbar already carries an add-reaction control; a
              // second one down here only earns its place when the body is
              // long enough that the toolbar has scrolled out of reach.
              hideAddButton={!isLongContent}
              className="mt-1.5"
            />
          </>
        )}
      </div>

      {/* Hover toolbar — react / reply / everything else. Revealed on hover
          AND on focus-within, so the keyboard reaches every action; kept
          permanently visible where there is no hover to reveal it with.
          `data-popup-open` holds it open while its own menu/picker is up:
          Base UI moves focus into the portaled popup, which would otherwise
          fade the very button the popup is anchored to. */}
      <div
        className={cn(
          "absolute right-2 top-1 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100",
          isMobile && "opacity-100",
        )}
      >
        <QuickEmojiPicker
          onSelect={(emoji) => onToggleReaction(entry.id, emoji)}
          align="end"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t(($) => $.comment.reply_aria)}
          onClick={() =>
            onStartReply({
              commentId: entry.id,
              authorLabel,
              strippedPreview: quotePreview(entry.content ?? ""),
            })
          }
        >
          <Reply className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t(($) => $.comment.more_actions_aria)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => {
              void copyText(entry.content ?? "").then((ok) => {
                if (ok) toast.success(t(($) => $.comment.copied_toast));
              });
            }}>
              <Copy className="h-3.5 w-3.5" />
              {t(($) => $.comment.copy_action)}
            </DropdownMenuItem>
            {onResolveToggle && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onResolveToggle(entry.id, !entry.resolved_at)}>
                  {entry.resolved_at ? (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t(($) => $.comment.resolve.unresolve_action)}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t(($) => $.comment.resolve.resolve_action)}
                    </>
                  )}
                </DropdownMenuItem>
              </>
            )}
            {(canEditEntry || canDeleteEntry) && (
              <>
                <DropdownMenuSeparator />
                {canEditEntry && (
                  <DropdownMenuItem onClick={edit.startEdit}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t(($) => $.comment.edit_action)}
                  </DropdownMenuItem>
                )}
                {canEditEntry && canDeleteEntry && <DropdownMenuSeparator />}
                {canDeleteEntry && (
                  <DropdownMenuItem onClick={() => setConfirmDelete(true)} variant="destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                    {t(($) => $.comment.delete_action)}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DeleteCommentDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onConfirm={() => onDelete(entry.id)}
          hasReplies={hasReplies}
        />
      </div>
    </div>
  );
}

// Memoized so a long timeline (e.g. Inbox-embedded IssueDetail with thousands
// of comments) does not re-render every row on each parent state update or
// WS-driven cache refresh. Default shallow comparison is sufficient: the
// timeline grouping is useMemo'd in issue-detail.tsx (stable Map ref), and
// every callback is stabilized via useCallback in use-issue-timeline.ts.
const CommentCard = memo(CommentCardImpl);

export { CommentCard, type CommentCardProps, type CommentParentRef };
