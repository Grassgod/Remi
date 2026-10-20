"use client";

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@multiremi/ui/lib/utils";
import {
  ContentEditor,
  type ContentEditorRef,
  type SubmitOptions,
  useFileDropZone,
  FileDropOverlay,
} from "../../editor";
import { FileUploadButton } from "@multiremi/ui/components/common/file-upload-button";
import { ArrowUp, Loader2, Pencil, Square } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  useChatStore,
  DRAFT_NEW_SESSION,
  type ChatFollowUpMode,
  type ChatQueueEdit,
} from "@multiremi/core/chat";
import { toSafeErrorDetails } from "@multiremi/core/api";
import { QUEUE_MAX_LIVE_ITEMS, queueErrorCode } from "@multiremi/core/chat/queue";
import { createLogger } from "@multiremi/core/logger";
import {
  getCurrentWsId,
  enterKey,
  formatShortcut,
  modKey,
  shiftKey,
} from "@multiremi/core/platform";
import type { UploadResult } from "@multiremi/core/hooks/use-file-upload";
import type { Attachment } from "@multiremi/core/types";
import type { MentionItem } from "../../editor/extensions/mention-suggestion";
import { useT } from "../../i18n";
import { CHAT_COLUMN_CLASS } from "../lib/chat-column";
import type { ChatModelDisplay } from "../lib/chat-model";
import { ChatModelChip } from "./chat-model-chip";

const logger = createLogger("chat.ui");

/**
 * How one message is delivered: `send` while idle; while a run is active the
 * follow-up preference, which Mod-Shift-Enter inverts for this message.
 */
export type ChatSendMode = "send" | ChatFollowUpMode;

const otherMode = (mode: ChatFollowUpMode): ChatFollowUpMode => mode === "steer" ? "queue" : "steer";

/** Queue refusals with their own copy; anything else keeps the generic one. */
function errorKind(error: unknown, fallback: "send" | "save"): "send" | "save" | "full" | "archived" {
  const code = queueErrorCode(error);
  return code === "queue_full" ? "full" : code === "chat_archived" ? "archived" : fallback;
}

export function chatSendMode(isRunning: boolean, preference: ChatFollowUpMode, invert: boolean): ChatSendMode {
  if (!isRunning) return "send";
  return invert ? otherMode(preference) : preference;
}

/** What the composer's one primary button does. */
export type ChatComposerAction = "save" | "stop" | ChatSendMode;

/**
 * The composer has one primary button, as in Codex: Save while a queued
 * message is being edited; while a run is active, Stop when the composer is
 * empty, otherwise the mode Mod-Enter would send with; Send while idle. A send
 * in flight keeps the (spinning) submit, so a double click cannot land on Stop.
 */
export function chatComposerAction({
  editing,
  isRunning,
  isEmpty,
  isSending,
  preference,
}: {
  editing: boolean;
  isRunning: boolean;
  isEmpty: boolean;
  isSending: boolean;
  preference: ChatFollowUpMode;
}): ChatComposerAction {
  if (editing) return "save";
  if (isRunning && isEmpty && !isSending) return "stop";
  return chatSendMode(isRunning, preference, false);
}

/** How long a first Esc keeps the composer's Stop armed for the second. */
export const STOP_CONFIRM_MS = 2_000;

interface ChatInputProps {
  /**
   * The chat on screen, or null for a new one. Its draft is the composer's,
   * so the draft can never belong to a different chat than the one shown.
   */
  sessionId: string | null;
  onSend: (
    content: string,
    attachmentIds?: string[],
    localAttachments?: Attachment[],
    mode?: ChatSendMode,
  ) => void | Promise<void>;
  /**
   * Saves the queued message being edited in this session's composer. It
   * settles the edit (restoring the stashed draft, or keeping the text when
   * the row can no longer change) and throws only for a retryable failure.
   */
  onSaveQueueEdit?: (
    sessionId: string,
    edit: ChatQueueEdit,
    content: string,
    attachmentIds: string[],
  ) => Promise<void>;
  /** Receives a File and returns the attachment row (with id + CDN link).
   *  The wrapper owner (ChatWindow) lazy-creates a chat_session if needed
   *  and forwards `chatSessionId` to the upload — chat-input only cares
   *  about the upload result so it can map URL → id for back-fill on send.
   *  When unset, paste/drag/button still type into the editor but no upload
   *  fires (the editor's file-upload extension is a no-op without a handler). */
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  onStop?: () => void;
  /** The stop button's name, when it needs to say more than 「停止」 (background tasks keep running). */
  stopLabel?: string;
  /**
   * Steers the first queued message into the running turn: the steer shortcut
   * (Mod-Shift-Enter while follow-ups queue) on an empty composer, as in Codex.
   */
  onSteerFirstQueued?: () => void;
  isRunning?: boolean;
  disabled?: boolean;
  /** True when the user has no agent available — disables the editor and
   *  surfaces a distinct placeholder. Kept separate from `disabled` so
   *  archived-session copy stays untouched. */
  noAgent?: boolean;
  /** Name of the currently selected agent, used in the placeholder. */
  agentName?: string;
  /**
   * Rendered at the bottom-left of the input bar: the agent and work-location
   * pickers. It shares one row with the actions and yields space to them; the
   * box is an `@container`, so its items can collapse when it is narrow.
   */
  leftAdornment?: ReactNode;
  /**
   * The model the chat runs on, shown read-only after the pickers; nothing
   * while there is no agent or it is still loading.
   */
  model?: ChatModelDisplay | null;
  /** Rendered before the action buttons at the bottom-right — the context ring. */
  rightAdornment?: ReactNode;
  /** Chat @ suggestions: current/recent issue/project entries. */
  contextItems?: MentionItem[];
}

export function ChatInput({
  sessionId,
  onSend,
  onSaveQueueEdit,
  onUploadFile,
  onStop,
  stopLabel,
  onSteerFirstQueued,
  isRunning,
  disabled,
  noAgent,
  agentName,
  leftAdornment,
  model,
  rightAdornment,
  contextItems,
}: ChatInputProps) {
  const { t } = useT("chat");
  const editorRef = useRef<ContentEditorRef>(null);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  // Draft storage follows the session shown. Editor identity changes when
  // the user switches chats, while lazy creation during upload/send keeps the
  // same editor mounted so in-flight attachment previews are retained.
  const draftKey =
    sessionId ?? `${DRAFT_NEW_SESSION}:${selectedAgentId ?? ""}`;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  // Select a primitive — empty-string fallback keeps referential stability.
  const inputDraft = useChatStore((s) => s.inputDrafts[draftKey] ?? "");
  const setInputDraft = useChatStore((s) => s.setInputDraft);
  const clearInputDraft = useChatStore((s) => s.clearInputDraft);
  const restoreToDraft = useChatStore((s) => s.restoreToDraft);
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
  /** `full` and `archived` are queue refusals with their own copy. */
  const [sendError, setSendError] = useState<"send" | "save" | "full" | "archived" | null>(null);
  const followUpMode = useChatStore((s) => s.followUpMode);
  const queueEdit = useChatStore((s) =>
    sessionId ? s.queueEdit[sessionId] : undefined,
  );
  const finishQueueEdit = useChatStore((s) => s.finishQueueEdit);
  const editorIdentity = useRef({ sessionId, version: 0 });
  if (editorIdentity.current.sessionId !== sessionId) {
    const lazyCreation =
      !editorIdentity.current.sessionId &&
      !!sessionId &&
      (pendingUploads > 0 || sendingRef.current);
    editorIdentity.current = {
      sessionId,
      version: editorIdentity.current.version + (lazyCreation ? 0 : 1),
    };
  }
  const editorKey = `${selectedAgentId ?? "no-agent"}:${editorIdentity.current.version}`;
  const currentEditorKey = () =>
    `${useChatStore.getState().selectedAgentId ?? "no-agent"}:${editorIdentity.current.version}`;

  // URL bindings share the draft store so opening the full page, reopening
  // the floating panel or switching sessions retains uploaded attachments.
  const setInputDraftAttachment = useChatStore(
    (s) => s.setInputDraftAttachment,
  );
  const setLocalAttachmentDetail = useChatStore((s) => s.setLocalAttachmentDetail);
  // The draft the editor shows. A draft of the same key changed from outside
  // the editor (a queued message loaded for editing, the stash put back) is
  // written into the editor; the editor's own updates are not echoed back.
  // A key change (switching chats, or the lazily created session of a first
  // send) is not an outside edit.
  const editorDraftRef = useRef({ key: draftKey, draft: inputDraft });
  useEffect(() => {
    editorDraftRef.current = { key: draftKey, draft: inputDraft };
    setIsEmpty(!inputDraft.trim());
    setSendError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey]);
  useEffect(() => {
    const previous = editorDraftRef.current;
    editorDraftRef.current = { key: draftKey, draft: inputDraft };
    if (previous.key !== draftKey || previous.draft === inputDraft) return;
    setIsEmpty(!inputDraft.trim());
    const editor = editorRef.current;
    if (!editor || editor.getMarkdown().trimEnd() === inputDraft.trimEnd()) return;
    editor.setContent(inputDraft);
  }, [draftKey, inputDraft]);

  // Editing a queued message: the composer takes focus once the row loaded
  // and the menu that started the edit has closed.
  const editingItemId = queueEdit?.itemId;
  useEffect(() => {
    if (!editingItemId) return;
    setSendError(null);
    const timer = setTimeout(() => editorRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [editingItemId]);

  const cancelQueueEdit = () => {
    if (sessionId) finishQueueEdit(sessionId, "restore");
  };

  const handleUpload = useCallback(
    async (file: File): Promise<UploadResult | null> => {
      if (!onUploadFile) return null;
      const workspaceAtUpload = getCurrentWsId();
      setPendingUploads((n) => n + 1);
      try {
        const result = await onUploadFile(file);
        if (getCurrentWsId() !== workspaceAtUpload) return null;
        if (result) {
          setLocalAttachmentDetail(result);
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
    [onUploadFile, draftKey, setInputDraftAttachment, setLocalAttachmentDetail],
  );

  // Drop zone wraps the rounded card so a drop anywhere on the input
  // surface routes the file through the editor's upload extension (same
  // handler as the in-editor paste path).
  const { isDragOver, dropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => editorRef.current?.uploadFile(f)),
  });

  const handleSend = async (options?: SubmitOptions) => {
    const content = editorRef.current
      ?.getMarkdown()
      ?.replace(/(\n\s*)+$/, "")
      .trim();
    // Mod-Shift-Enter on an empty composer, while it would steer, steers the
    // first queued message instead (Codex); focus stays here. Mod-Enter on an
    // empty composer still does nothing.
    if (
      !content &&
      options?.invert &&
      isRunning &&
      !disabled &&
      !noAgent &&
      !sendingRef.current &&
      !(sessionId && useChatStore.getState().queueEdit[sessionId]) &&
      chatSendMode(true, followUpMode, true) === "steer"
    ) {
      logger.info("input.steer_first_queued");
      onSteerFirstQueued?.();
      return;
    }
    if (
      !content ||
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
    const store = useChatStore.getState();
    const bindings = Object.entries(store.inputDraftAttachments[draftKey] ?? {})
      .filter(([url]) => content.includes(url));
    const activeIds = bindings.map(([, id]) => id);
    const localAttachments = activeIds
      .map((id) => store.localAttachmentDetails[id])
      .filter((item): item is Attachment => !!item);
    // Capture draft key BEFORE onSend — creating a new session changes the
    // chat shown, so reading it after onSend would point at the new session.
    const keyAtSend = draftKey;
    const workspaceAtSend = getCurrentWsId();
    const editorAtSend = editorKey;
    // Saving an edited queued message settles the draft through the store
    // (the stash comes back); nothing is cleared here.
    const edit = sessionId ? store.queueEdit[sessionId] : undefined;
    if (edit && sessionId) {
      logger.info("input.save_queued", { contentLength: content.length, attachmentCount: activeIds.length });
      sendingRef.current = true;
      setIsSending(true);
      setSendError(null);
      try {
        await onSaveQueueEdit?.(sessionId, edit, content, activeIds);
      } catch (error) {
        logger.error("input.save_queued.error", { error: toSafeErrorDetails(error) });
        if (getCurrentWsId() === workspaceAtSend) setSendError(errorKind(error, "save"));
      } finally {
        sendingRef.current = false;
        setIsSending(false);
      }
      return;
    }
    const mode = chatSendMode(!!isRunning, followUpMode, options?.invert ?? false);
    logger.info("input.send", {
      contentLength: content.length,
      draftKey: keyAtSend,
      attachmentCount: activeIds.length,
      mode,
    });
    sendingRef.current = true;
    setIsSending(true);
    setSendError(null);
    // The message leaves the composer as it is submitted, from the draft it was
    // typed in; a failure puts it back. The editor shows exactly the sent text
    // here, and nothing later clears it, so whatever the user types while the
    // send is in flight stays, whichever chat the send lands in. The editor is
    // emptied without an update: the draft is cleared right here, and the
    // editor's debounced echo of it would land after the key moved to the
    // chat this send creates.
    editorRef.current?.setContent("");
    editorDraftRef.current = { key: keyAtSend, draft: "" };
    clearInputDraft(keyAtSend);
    setIsEmpty(true);
    try {
      await onSend(content, activeIds.length > 0 ? activeIds : undefined, localAttachments, mode);
    } catch (error) {
      logger.error("input.send.error", {
        draftKey: keyAtSend,
        contentLength: content.length,
        attachmentCount: activeIds.length,
        error: toSafeErrorDetails(error),
      });
      if (getCurrentWsId() !== workspaceAtSend) return;
      for (const attachment of localAttachments) setLocalAttachmentDetail(attachment);
      // The same editor puts the text back under the chat it shows now (the
      // lazily created one included), before anything typed since. After a
      // switch to another chat the text returns to the draft it was typed in.
      const sameEditor = currentEditorKey() === editorAtSend;
      const key = sameEditor ? draftKeyRef.current : keyAtSend;
      const editor = sameEditor ? editorRef.current : null;
      if (sameEditor) setSendError(errorKind(error, "send"));
      if (editor && !useChatStore.getState().queueEdit[key]) {
        const typed = editor.getMarkdown().trim();
        const text = typed ? `${content}\n\n${typed}` : content;
        editor.setContent(text);
        editorDraftRef.current = { key, draft: text };
        setInputDraft(key, text);
        for (const [url, id] of bindings) setInputDraftAttachment(key, url, id);
        setIsEmpty(false);
      } else {
        // A stored draft (or a queued edit's stash) takes it after its own text.
        restoreToDraft(key, content, Object.fromEntries(bindings));
      }
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

  const submitShortcut = formatShortcut(modKey, enterKey);
  const invertShortcut = formatShortcut(modKey, shiftKey, enterKey);
  const modeLabel = (mode: ChatFollowUpMode) =>
    mode === "steer" ? t(($) => $.input.steer) : t(($) => $.input.queue);
  const action = chatComposerAction({
    editing: !!queueEdit,
    isRunning: !!isRunning,
    isEmpty,
    isSending,
    preference: followUpMode,
  });
  const stopText = stopLabel ?? t(($) => $.input.stop_tooltip);
  const submitDisabled =
    isEmpty || !!disabled || !!noAgent || pendingUploads > 0 || isSending;

  // While typed text turns the button into a submit, Esc twice stops the run
  // without clearing the draft: the first Esc arms Stop and says so, a second
  // one within STOP_CONFIRM_MS stops. Any other key, or the run ending, disarms.
  const [stopArmed, setStopArmed] = useState(false);
  useEffect(() => {
    if (!stopArmed) return;
    const timer = setTimeout(() => setStopArmed(false), STOP_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed]);
  useEffect(() => {
    if (!isRunning) setStopArmed(false);
  }, [isRunning]);
  const canStop = !!isRunning && !!onStop && !queueEdit;
  const stopConfirming = stopArmed && canStop;
  const stop = () => {
    setStopArmed(false);
    onStop?.();
  };

  // Esc leaves the queued-message edit, or arms and confirms Stop. An open @
  // or / suggestion keeps the key: it marks its query with the `.suggestion`
  // decoration. A handled key stops here, so the editor's Escape-to-blur does
  // not also run and the composer keeps focus.
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Escape") {
      if (stopArmed) setStopArmed(false);
      return;
    }
    if (!queueEdit && !canStop) return;
    if (event.currentTarget.querySelector(".suggestion")) return;
    event.preventDefault();
    event.stopPropagation();
    if (queueEdit) cancelQueueEdit();
    else if (stopConfirming) {
      logger.info("input.stop_from_escape");
      stop();
    } else setStopArmed(true);
  };

  // A send empties the composer, so the button under the pointer becomes Stop:
  // the second click of a double click must not stop the run it just started.
  const handleStopClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1) return;
    stop();
  };
  const submitLabel = action === "steer" || action === "queue"
    ? modeLabel(action)
    : t(($) => $.input.send_tooltip);
  const submitTitle = action === "steer" || action === "queue"
    ? `${submitLabel} · ${submitShortcut}\n${modeLabel(otherMode(action))} · ${invertShortcut}`
    : `${submitLabel} · ${submitShortcut}`;

  return (
    <div
      className={cn(
        // The composer's border is the Chat column's edge, like the message text above.
        CHAT_COLUMN_CLASS,
        "pb-3",
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
          "relative flex min-h-16 max-h-40 w-full flex-col rounded-lg bg-card pb-9 border-1 border-border transition-colors focus-within:border-brand",
          // Visual + interaction lock when there's no agent. We don't
          // toggle ContentEditor's editable mode (Tiptap can't switch
          // cleanly post-mount, and the prop has been removed); instead
          // we drop pointer events at the wrapper level so clicks miss
          // the editor entirely, and dim the surface so it reads as
          // "disabled" rather than "broken".
          (noAgent || disabled) && "pointer-events-none opacity-60",
        )}
        aria-disabled={noAgent || disabled || undefined}
        data-chat-composer=""
        onKeyDownCapture={handleKeyDownCapture}
        // The editor reports text after its debounce; typing replaces Stop
        // with the submit at once, so Stop never sits under typed text.
        onInput={(event) => {
          if (isEmpty && (event.target as HTMLElement).textContent?.trim()) setIsEmpty(false);
        }}
      >
        {queueEdit && (
          <div
            data-chat-queue-edit=""
            className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1 text-xs text-muted-foreground"
          >
            <Pencil className="size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{t(($) => $.input.editing_queued)}</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="shrink-0 font-medium text-foreground hover:underline"
              onClick={cancelQueueEdit}
            >
              {t(($) => $.input.cancel_edit)}
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
          <ContentEditor
            // The identity above distinguishes session switching from lazy creation.
            key={editorKey}
            ref={editorRef}
            defaultValue={inputDraft}
            placeholder={placeholder}
            onUpdate={(md) => {
              setIsEmpty(!md.trim());
              editorDraftRef.current = { key: draftKey, draft: md };
              setInputDraft(draftKey, md);
            }}
            onSubmit={(options) => void handleSend(options)}
            invertibleSubmit
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
            // Mod+Shift+Enter sends with the other follow-up mode. Which keys
            // submit, and with `invert`, is decided only in createSubmitExtension.
          />
        </div>
        {/* One footer row: the pickers take what the actions leave, so they
         *  never run under the send controls at any width. */}
        <div data-chat-composer-footer="" className="absolute inset-x-1.5 bottom-1 flex items-center gap-2">
          <div data-chat-composer-footer-start="" className="@container flex min-w-0 flex-1 items-center gap-1 pl-0.5">
            {leftAdornment}
            {model && <ChatModelChip model={model} />}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {rightAdornment}
            {uploadEnabled && (
              <FileUploadButton
                size="sm"
                onSelect={(file) => editorRef.current?.uploadFile(file)}
              />
            )}
            {/* One primary button (chatComposerAction). The branches render the
             *  same Button, so it keeps focus as it changes. */}
            {action === "save" ? (
              <Button
                size="sm"
                onClick={() => void handleSend()}
                disabled={submitDisabled}
                title={`${t(($) => $.input.save)} · ${submitShortcut}`}
              >
                {isSending && <Loader2 className="size-3.5 animate-spin" />}
                {t(($) => $.input.save)}
              </Button>
            ) : action === "stop" ? (
              <Button
                size="icon-sm"
                onClick={handleStopClick}
                disabled={!onStop}
                aria-label={stopText}
                title={`${stopText} · Esc Esc`}
                data-composer-action="stop"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                onClick={() => void handleSend()}
                disabled={submitDisabled}
                aria-label={submitLabel}
                title={submitTitle}
                data-composer-action={action}
              >
                {isSending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
        {uploadEnabled && isDragOver && <FileDropOverlay />}
      </div>
      {sendError && (
        <p
          role="alert"
          className="mt-2 text-xs text-destructive"
        >
          {sendError === "full"
            ? t(($) => $.queue.full, { max: QUEUE_MAX_LIVE_ITEMS })
            : sendError === "archived"
              ? t(($) => $.queue.archived)
              : sendError === "save"
                ? t(($) => $.queue.failed)
                : t(($) => $.input.send_failed)}
        </p>
      )}
      {stopConfirming && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t(($) => $.input.stop_confirm, { label: stopText })}
        </p>
      )}
    </div>
  );
}
