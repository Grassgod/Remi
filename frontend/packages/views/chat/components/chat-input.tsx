"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@multiremi/ui/lib/utils";
import {
  ContentEditor,
  type ContentEditorRef,
  useFileDropZone,
  FileDropOverlay,
} from "../../editor";
import { FileUploadButton } from "@multiremi/ui/components/common/file-upload-button";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { useChatStore, DRAFT_NEW_SESSION } from "@multiremi/core/chat";
import { createLogger } from "@multiremi/core/logger";
import {
  getCurrentWsId,
  enterKey,
  formatShortcut,
  modKey,
} from "@multiremi/core/platform";
import type { UploadResult } from "@multiremi/core/hooks/use-file-upload";
import type { MentionItem } from "../../editor/extensions/mention-suggestion";
import { useT } from "../../i18n";

const logger = createLogger("chat.ui");

interface ChatInputProps {
  onSend: (content: string, attachmentIds?: string[]) => void | Promise<void>;
  /** Receives a File and returns the attachment row (with id + CDN link).
   *  The wrapper owner (ChatWindow) lazy-creates a chat_session if needed
   *  and forwards `chatSessionId` to the upload — chat-input only cares
   *  about the upload result so it can map URL → id for back-fill on send.
   *  When unset, paste/drag/button still type into the editor but no upload
   *  fires (the editor's file-upload extension is a no-op without a handler). */
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  onStop?: () => void;
  isRunning?: boolean;
  supportsQueue?: boolean;
  disabled?: boolean;
  /** True when the user has no agent available — disables the editor and
   *  surfaces a distinct placeholder. Kept separate from `disabled` so
   *  archived-session copy stays untouched. */
  noAgent?: boolean;
  /** Name of the currently selected agent, used in the placeholder. */
  agentName?: string;
  /** Rendered at the bottom-left of the input bar — typically the agent picker. */
  leftAdornment?: ReactNode;
  /** Chat @ suggestions: current/recent issue/project entries. */
  contextItems?: MentionItem[];
}

export function ChatInput({
  onSend,
  onUploadFile,
  onStop,
  isRunning,
  supportsQueue,
  disabled,
  noAgent,
  agentName,
  leftAdornment,
  contextItems,
}: ChatInputProps) {
  const { t } = useT("chat");
  const editorRef = useRef<ContentEditorRef>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  // Draft storage follows the session. Editor identity changes when the
  // user switches chats, while lazy creation during upload/send keeps the
  // same editor mounted so in-flight attachment previews are retained.
  const draftKey =
    activeSessionId ?? `${DRAFT_NEW_SESSION}:${selectedAgentId ?? ""}`;

  // Select a primitive — empty-string fallback keeps referential stability.
  const inputDraft = useChatStore((s) => s.inputDrafts[draftKey] ?? "");
  const setInputDraft = useChatStore((s) => s.setInputDraft);
  const clearInputDraft = useChatStore((s) => s.clearInputDraft);
  const [isEmpty, setIsEmpty] = useState(!inputDraft.trim());
  // Number of in-flight uploads. We track this explicitly (rather than
  // peeking at the editor on every render) so the SubmitButton visibly
  // disables the instant an upload starts and re-enables the instant it
  // finishes. handleSend ALSO checks `hasActiveUploads()` for paths that
  // bypass the button (Mod+Enter while paste is mid-stream, drag-drop
  // racing the keyboard) — defense in depth.
  const [pendingUploads, setPendingUploads] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState(false);
  const editorIdentity = useRef({ sessionId: activeSessionId, version: 0 });
  if (editorIdentity.current.sessionId !== activeSessionId) {
    const lazyCreation =
      !editorIdentity.current.sessionId &&
      !!activeSessionId &&
      (pendingUploads > 0 || sendingRef.current);
    editorIdentity.current = {
      sessionId: activeSessionId,
      version: editorIdentity.current.version + (lazyCreation ? 0 : 1),
    };
  }
  const editorKey = `${selectedAgentId ?? "no-agent"}:${editorIdentity.current.version}`;

  // URL bindings share the draft store so opening the full page, reopening
  // the floating panel or switching sessions retains uploaded attachments.
  const setInputDraftAttachment = useChatStore(
    (s) => s.setInputDraftAttachment,
  );
  useEffect(() => {
    setIsEmpty(!inputDraft.trim());
    setSendError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey]);

  const handleUpload = useCallback(
    async (file: File): Promise<UploadResult | null> => {
      if (!onUploadFile) return null;
      const workspaceAtUpload = getCurrentWsId();
      setPendingUploads((n) => n + 1);
      try {
        const result = await onUploadFile(file);
        if (getCurrentWsId() !== workspaceAtUpload) return null;
        if (result) {
          setInputDraftAttachment(
            result.chat_session_id ?? draftKey,
            result.link,
            result.id,
          );
        }
        return result;
      } finally {
        setPendingUploads((n) => Math.max(0, n - 1));
      }
    },
    [onUploadFile, draftKey, setInputDraftAttachment],
  );

  // Drop zone wraps the rounded card so a drop anywhere on the input
  // surface routes the file through the editor's upload extension (same
  // handler as the in-editor paste path).
  const { isDragOver, dropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => editorRef.current?.uploadFile(f)),
  });

  const handleSend = async () => {
    const content = editorRef.current
      ?.getMarkdown()
      ?.replace(/(\n\s*)+$/, "")
      .trim();
    if (
      !content ||
      (isRunning && !supportsQueue) ||
      disabled ||
      noAgent ||
      sendingRef.current
    ) {
      logger.debug("input.send skipped", {
        emptyContent: !content,
        isRunning,
        disabled,
        noAgent,
      });
      return;
    }
    // Block the send while any file is still uploading. If we let it
    // through the attachment binding has not been stored yet (the upload
    // resolves later) and the attachment would only end up bound to the
    // session, not the message — the agent then can't `multimira attachment
    // download <id>` the file. The SubmitButton is also disabled in this
    // state via `uploading`, but Mod+Enter bypasses the button so we
    // still gate here.
    if (editorRef.current?.hasActiveUploads()) {
      logger.debug("input.send skipped: uploads in flight");
      return;
    }
    // Only send attachment IDs for uploads still present in the content.
    // Edits / deletions that remove the markdown URL also drop the binding.
    const activeIds: string[] = [];
    for (const [url, id] of Object.entries(
      useChatStore.getState().inputDraftAttachments[draftKey] ?? {},
    )) {
      if (content.includes(url)) activeIds.push(id);
    }
    // Capture draft key BEFORE onSend — creating a new session mutates
    // activeSessionId synchronously, so reading it after onSend would point
    // at the new session and leave the old draft orphaned.
    const keyAtSend = draftKey;
    const workspaceAtSend = getCurrentWsId();
    const editorAtSend = editorKey;
    logger.info("input.send", {
      contentLength: content.length,
      draftKey: keyAtSend,
      attachmentCount: activeIds.length,
    });
    sendingRef.current = true;
    setIsSending(true);
    setSendError(false);
    try {
      await onSend(content, activeIds.length > 0 ? activeIds : undefined);
      if (getCurrentWsId() !== workspaceAtSend) return;
      // A user may keep typing while the request is in flight. Only clear
      // the submitted content; retain subsequent edits and their attachments.
      const current = editorRef.current?.getMarkdown()?.trim();
      if (
        `${useChatStore.getState().selectedAgentId ?? "no-agent"}:${editorIdentity.current.version}` ===
          editorAtSend &&
        current === content
      ) {
        editorRef.current?.clearContent();
        clearInputDraft(keyAtSend);
        const currentSession = useChatStore.getState().activeSessionId;
        if (currentSession && currentSession !== keyAtSend)
          clearInputDraft(currentSession);
        setIsEmpty(true);
      }
    } catch {
      if (getCurrentWsId() !== workspaceAtSend) return;
      if (
        `${useChatStore.getState().selectedAgentId ?? "no-agent"}:${editorIdentity.current.version}` !==
        editorAtSend
      )
        return;
      setSendError(true);
      const currentSession = useChatStore.getState().activeSessionId;
      if (currentSession)
        setInputDraft(
          currentSession,
          editorRef.current?.getMarkdown() ?? content,
        );
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  const placeholder = noAgent
    ? t(($) => $.input.placeholder_no_agent)
    : disabled
      ? t(($) => $.input.placeholder_archived)
      : agentName
        ? t(($) => $.input.placeholder_named, { name: agentName })
        : t(($) => $.input.placeholder_default);

  const uploadEnabled = !!onUploadFile && !disabled && !noAgent;

  return (
    <div
      className={cn(
        "px-5 pb-3 pt-0",
        // Outer wrapper carries the disabled cursor. Inner card sets
        // pointer-events-none, which suppresses hover (and therefore
        // any cursor of its own) — splitting the two layers lets hover
        // bubble back here so the browser actually reads cursor.
        (noAgent || disabled) && "cursor-not-allowed",
      )}
    >
      <div
        {...(uploadEnabled ? dropZoneProps : {})}
        className={cn(
          "relative mx-auto flex min-h-16 max-h-40 w-full max-w-4xl flex-col rounded-lg bg-card pb-9 border-1 border-border transition-colors focus-within:border-brand",
          // Visual + interaction lock when there's no agent. We don't
          // toggle ContentEditor's editable mode (Tiptap can't switch
          // cleanly post-mount, and the prop has been removed); instead
          // we drop pointer events at the wrapper level so clicks miss
          // the editor entirely, and dim the surface so it reads as
          // "disabled" rather than "broken".
          (noAgent || disabled) && "pointer-events-none opacity-60",
        )}
        aria-disabled={noAgent || disabled || undefined}
      >
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
          <ContentEditor
            // The identity above distinguishes session switching from lazy creation.
            key={editorKey}
            ref={editorRef}
            defaultValue={inputDraft}
            placeholder={placeholder}
            onUpdate={(md) => {
              setIsEmpty(!md.trim());
              setInputDraft(draftKey, md);
            }}
            onSubmit={handleSend}
            onUploadFile={uploadEnabled ? handleUpload : undefined}
            debounceMs={100}
            mentionMode={contextItems ? "context" : "default"}
            mentionContextItems={contextItems}
            enableSlashCommands
            // Chat is short-form — the floating formatting toolbar is
            // more distraction than feature here.
            showBubbleMenu={false}
            // Chat intentionally leaves submitOnEnter at its default false:
            // Mod+Enter submits, while bare Enter falls through to Tiptap's
            // default behavior for lists, quotes, and paragraph breaks.
            // Without this, Enter-as-send would steal the only key that
            // continues a bullet list, leaving users stuck after one item.
          />
        </div>
        {leftAdornment && (
          <div className="absolute bottom-1.5 left-2 flex items-center">
            {leftAdornment}
          </div>
        )}
        <div className="absolute bottom-1 right-1.5 flex items-center gap-1">
          {uploadEnabled && (
            <FileUploadButton
              size="sm"
              onSelect={(file) => editorRef.current?.uploadFile(file)}
            />
          )}
          {isRunning && (
            <Button
              size="icon-sm"
              aria-label={t(($) => $.input.stop_tooltip)}
              title={t(($) => $.input.stop_tooltip)}
              onClick={onStop}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
          {(!isRunning || supportsQueue) && (
            <Button
              size="icon-sm"
              onClick={() => void handleSend()}
              disabled={
                isEmpty ||
                !!disabled ||
                !!noAgent ||
                pendingUploads > 0 ||
                isSending
              }
              aria-label={
                isRunning
                  ? t(($) => $.queue.add)
                  : t(($) => $.input.send_tooltip)
              }
              title={`${isRunning ? t(($) => $.queue.add) : t(($) => $.input.send_tooltip)} · ${formatShortcut(modKey, enterKey)}`}
            >
              {isSending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          )}
        </div>
        {uploadEnabled && isDragOver && <FileDropOverlay />}
      </div>
      {sendError && (
        <p
          role="alert"
          className="mx-auto mt-2 max-w-4xl text-xs text-destructive"
        >
          {t(($) => $.input.send_failed)}
        </p>
      )}
    </div>
  );
}
