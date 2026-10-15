import { create } from "zustand";
import type { Attachment, StorageAdapter } from "../types";
import type { QueuedMessageAttachment } from "../api/schemas/chat-queue";
import { getCurrentSlug, registerForWorkspaceRehydration } from "../platform/workspace-storage";
import { createLogger } from "../logger";

const logger = createLogger("chat.store");

const AGENT_STORAGE_KEY = "multimira:chat:selectedAgentId";
const DRAFT_PROJECT_KEY = "multimira:chat:draftProjectId";
const SESSION_STORAGE_KEY = "multimira:chat:activeSessionId";
/** Drafts are stored as one JSON blob per workspace: { [sessionId]: text }. */
const DRAFTS_KEY = "multimira:chat:drafts";
/** Uploaded attachment references must survive switching between chat surfaces. */
const DRAFT_ATTACHMENTS_KEY = "multimira:chat:draftAttachments";
/** Placeholder sessionId for a chat that hasn't been created yet. */
export const DRAFT_NEW_SESSION = "__new__";
const CHAT_WIDTH_KEY = "multimira:chat:width";
const CHAT_HEIGHT_KEY = "multimira:chat:height";
const CHAT_EXPANDED_KEY = "multimira:chat:expanded";
/**
 * Open/closed preference, persisted globally (not per-workspace) — most users
 * have one habitual chat-panel preference across workspaces. Missing key =
 * new user (or cleared storage); default to OPEN so the chat is discoverable.
 * Once the user toggles even once, their explicit choice is respected on
 * every subsequent reload.
 */
const OPEN_KEY = "multimira:chat:isOpen";
/** How a message sent during a run is delivered; one global preference. */
const FOLLOW_UP_MODE_KEY = "multimira:chat:followUpMode";
/** Queued-message edits in progress, with the composer draft they replaced. */
const QUEUE_EDIT_KEY = "multimira:chat:queueEdit";
/** Enqueues the server has not confirmed, per workspace. */
const QUEUE_OUTBOX_KEY = "multimira:chat:queueOutbox";

/**
 * While a run is active, `steer` (引导) sends into the running turn and
 * `queue` (排队) holds the message until the turn completes (ADR 0020).
 */
export type ChatFollowUpMode = "steer" | "queue";
export const DEFAULT_FOLLOW_UP_MODE: ChatFollowUpMode = "steer";

function readFollowUpMode(storage: StorageAdapter): ChatFollowUpMode {
  const stored = storage.getItem(FOLLOW_UP_MODE_KEY);
  return stored === "queue" || stored === "steer" ? stored : DEFAULT_FOLLOW_UP_MODE;
}

/** A queued message loaded into the composer for editing. */
export interface ChatQueueEdit {
  itemId: string;
  /** Revision the edit started from; the save sends it as `expected_revision`. */
  revision: number;
  /** The composer draft the edit replaced, restored when the edit ends. */
  stash: { draft: string; attachments: Record<string, string> };
}

/**
 * An enqueue the server has not answered yet. `unconfirmed` means it failed
 * without an HTTP status: the row may or may not exist, so it is never retried
 * automatically. Retrying with the same `client_id` is idempotent.
 */
export interface ChatQueueOutboxItem {
  client_id: string;
  body_md: string;
  attachment_ids?: string[];
  attachments: QueuedMessageAttachment[];
  created_at: string;
  state: "sending" | "unconfirmed";
}

function readDrafts(storage: StorageAdapter, key: string): Record<string, string> {
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeDrafts(storage: StorageAdapter, key: string, drafts: Record<string, string>) {
  // Prune empty entries so the blob doesn't grow unbounded.
  const pruned: Record<string, string> = {};
  for (const [k, v] of Object.entries(drafts)) {
    if (v) pruned[k] = v;
  }
  if (Object.keys(pruned).length === 0) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, JSON.stringify(pruned));
  }
}

function readDraftAttachments(storage: StorageAdapter, key: string): Record<string, Record<string, string>> {
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, Record<string, string>> = {};
    for (const [draftKey, entries] of Object.entries(parsed)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      const attachments = Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      if (Object.keys(attachments).length) drafts[draftKey] = attachments;
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeDraftAttachments(storage: StorageAdapter, key: string, drafts: Record<string, Record<string, string>>): void {
  if (Object.keys(drafts).length) storage.setItem(key, JSON.stringify(drafts));
  else storage.removeItem(key);
}

function readJsonRecord(storage: StorageAdapter, key: string): Record<string, unknown> {
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeJsonRecord(storage: StorageAdapter, key: string, value: Record<string, unknown>): void {
  if (Object.keys(value).length) storage.setItem(key, JSON.stringify(value));
  else storage.removeItem(key);
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === "string");

function readQueueEdits(storage: StorageAdapter, key: string): Record<string, ChatQueueEdit> {
  const edits: Record<string, ChatQueueEdit> = {};
  for (const [sessionId, value] of Object.entries(readJsonRecord(storage, key))) {
    const edit = value as Partial<ChatQueueEdit> | null;
    if (!edit || typeof edit.itemId !== "string" || typeof edit.revision !== "number"
      || !edit.stash || typeof edit.stash.draft !== "string" || !isStringRecord(edit.stash.attachments)) continue;
    edits[sessionId] = { itemId: edit.itemId, revision: edit.revision, stash: edit.stash };
  }
  return edits;
}

function readQueueOutbox(storage: StorageAdapter, key: string): Record<string, ChatQueueOutboxItem[]> {
  const outbox: Record<string, ChatQueueOutboxItem[]> = {};
  for (const [sessionId, value] of Object.entries(readJsonRecord(storage, key))) {
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is ChatQueueOutboxItem =>
      !!item && typeof item.client_id === "string" && typeof item.body_md === "string"
      && typeof item.created_at === "string" && Array.isArray(item.attachments))
      // A reload cannot know whether an in-flight enqueue arrived.
      .map((item) => ({ ...item, state: "unconfirmed" as const }));
    if (items.length) outbox[sessionId] = items;
  }
  return outbox;
}

/**
 * What the subagent panel shows (PR 5): one attempt of one chat, its overview
 * (`path` empty) or a subagent's detail. `path` holds the subagent item ids
 * from a top-level subagent down to the open one; back drops the last id.
 */
export interface SubagentPanelTarget {
  /** The chat the panel belongs to; another chat never shows it. */
  sessionId: string | null;
  /** The attempt whose trace holds the subagents. */
  attemptId: string;
  /** The turn of that attempt, when known; reads go through the turn route. */
  turnId?: string;
  /** Follow the trace socket (the running turn). */
  live: boolean;
  path: string[];
}

/** A request to show a top-level subagent's row in the live steps fold. */
export interface SubagentRevealRequest {
  attemptId: string;
  itemId: string;
  /**
   * Increases with every request for the life of the store, also across
   * clears: a fold acts only on requests newer than the one it saw when it
   * mounted, and revealing the same row twice still fires.
   */
  nonce: number;
}

export const CHAT_MIN_W = 360;
export const CHAT_MIN_H = 480;
export const CHAT_DEFAULT_W = 380;
export const CHAT_DEFAULT_H = 600;

export interface ChatState {
  isOpen: boolean;
  activeSessionId: string | null;
  selectedAgentId: string | null;
  /** Project selected for a new conversation; existing bindings live in Query. */
  draftProjectId: string | null;
  /** Drafts per session: sessionId (or DRAFT_NEW_SESSION) → markdown text. */
  inputDrafts: Record<string, string>;
  inputDraftAttachments: Record<string, Record<string, string>>;
  /** Upload details shared between the panel and page until the server row arrives. */
  localAttachmentDetails: Record<string, Attachment>;
  /** Raw user-chosen size — no clamp applied. UI layer clamps at render time. */
  chatWidth: number;
  chatHeight: number;
  isExpanded: boolean;
  /** Default delivery for a message sent while a run is active. */
  followUpMode: ChatFollowUpMode;
  /** Queued-message edit in progress, by session. */
  queueEdit: Record<string, ChatQueueEdit>;
  /** Enqueues not yet confirmed by the server, by session. */
  queueOutbox: Record<string, ChatQueueOutboxItem[]>;
  /** The open subagent panel, or null. Not persisted. */
  subagentPanel: SubagentPanelTarget | null;
  /** The last reveal request for a subagent row. Not persisted. */
  subagentReveal: SubagentRevealRequest | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setActiveSession: (id: string | null) => void;
  setSelectedAgentId: (id: string) => void;
  setDraftProjectId: (id: string | null) => void;
  /** sessionId accepts a real session UUID or DRAFT_NEW_SESSION. */
  setInputDraft: (sessionId: string, draft: string) => void;
  clearInputDraft: (sessionId: string) => void;
  setInputDraftAttachment: (draftKey: string, url: string, attachmentId: string) => void;
  setLocalAttachmentDetail: (attachment: Attachment) => void;
  clearInputDraftAttachments: (draftKey: string) => void;
  /** Persist raw size and auto-exit expanded mode. */
  setChatSize: (width: number, height: number) => void;
  setExpanded: (expanded: boolean) => void;
  setFollowUpMode: (mode: ChatFollowUpMode) => void;
  /**
   * Loads a queued message into the session's composer draft. The draft it
   * replaces is stashed; switching to another queued message keeps the
   * original stash.
   */
  startQueueEdit: (sessionId: string, edit: {
    itemId: string; revision: number; body_md: string; attachments: Record<string, string>;
  }) => void;
  /**
   * `restore` puts the stashed draft back (save or cancel). `keep` leaves the
   * edited text as an ordinary draft, followed by the stashed one, when the
   * row can no longer be saved. `keptText` is the text the user submitted;
   * without it the (debounced) stored draft is kept.
   */
  finishQueueEdit: (sessionId: string, outcome: "restore" | "keep", keptText?: string) => void;
  /** Adds or replaces the outbox item with the same `client_id`. */
  putQueueOutboxItem: (sessionId: string, item: ChatQueueOutboxItem) => void;
  /**
   * `workspaceSlug` names the workspace the enqueue started in; when the user
   * has switched since, the item is removed from that workspace's stored
   * outbox instead of the current one.
   */
  removeQueueOutboxItem: (sessionId: string, clientId: string, workspaceSlug?: string | null) => void;
  /** Drops the queued-message edit and outbox of a deleted session. */
  clearQueueState: (sessionId: string) => void;
  /**
   * Appends text the queue could not keep to the session's draft, with its
   * attachment bindings. During a queued-message edit it joins the stashed
   * draft instead, so the edit being saved does not pick it up.
   */
  restoreToDraft: (sessionId: string, body: string, attachments: Record<string, string>) => void;
  /** Opens (or retargets) the subagent panel. */
  openSubagentPanel: (target: SubagentPanelTarget) => void;
  /** Moves the open panel to another subagent, or to the overview with `[]`. */
  setSubagentPath: (path: string[]) => void;
  /** Closes the panel and drops any pending reveal request. */
  closeSubagentPanel: () => void;
  /** Asks the live steps fold to open and scroll to a top-level subagent's row. */
  revealSubagent: (attemptId: string, itemId: string) => void;
}

export interface ChatStoreOptions {
  storage: StorageAdapter;
}

export function createChatStore(options: ChatStoreOptions) {
  const { storage } = options;

  const wsKey = (base: string) => {
    const slug = getCurrentSlug();
    return slug ? `${base}:${slug}` : base;
  };

  // Resolve initial isOpen from storage. The three-state read (null /
  // "true" / "false") is what enables the "new user → open" default while
  // still honouring an explicit "I closed it" choice on every reload.
  const storedOpen = storage.getItem(OPEN_KEY);
  const initialIsOpen = storedOpen === null ? true : storedOpen === "true";
  /** Reveal nonces never repeat, even after a request is cleared. */
  let revealNonce = 0;

  const store = create<ChatState>((set, get) => ({
    isOpen: initialIsOpen,
    activeSessionId: storage.getItem(wsKey(SESSION_STORAGE_KEY)),
    selectedAgentId: storage.getItem(wsKey(AGENT_STORAGE_KEY)),
    draftProjectId: storage.getItem(wsKey(DRAFT_PROJECT_KEY)),
    inputDrafts: readDrafts(storage, wsKey(DRAFTS_KEY)),
    inputDraftAttachments: readDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY)),
    localAttachmentDetails: {},
    chatWidth: Number(storage.getItem(CHAT_WIDTH_KEY)) || CHAT_DEFAULT_W,
    chatHeight: Number(storage.getItem(CHAT_HEIGHT_KEY)) || CHAT_DEFAULT_H,
    isExpanded: storage.getItem(wsKey(CHAT_EXPANDED_KEY)) === "true",
    followUpMode: readFollowUpMode(storage),
    queueEdit: readQueueEdits(storage, wsKey(QUEUE_EDIT_KEY)),
    queueOutbox: readQueueOutbox(storage, wsKey(QUEUE_OUTBOX_KEY)),
    subagentPanel: null,
    subagentReveal: null,
    setOpen: (open) => {
      logger.debug("setOpen", { from: get().isOpen, to: open });
      storage.setItem(OPEN_KEY, String(open));
      set({ isOpen: open });
    },
    toggle: () => {
      const next = !get().isOpen;
      logger.debug("toggle", { to: next });
      storage.setItem(OPEN_KEY, String(next));
      set({ isOpen: next });
    },
    setActiveSession: (id) => {
      logger.info("setActiveSession", { from: get().activeSessionId, to: id });
      if (id) {
        storage.setItem(wsKey(SESSION_STORAGE_KEY), id);
      } else {
        storage.removeItem(wsKey(SESSION_STORAGE_KEY));
      }
      // The subagent panel and a reveal request belong to one chat.
      const subagents = id !== get().activeSessionId ? { subagentPanel: null, subagentReveal: null } : {};
      set({ activeSessionId: id, ...subagents });
    },
    setSelectedAgentId: (id) => {
      logger.info("setSelectedAgentId", { from: get().selectedAgentId, to: id });
      storage.setItem(wsKey(AGENT_STORAGE_KEY), id);
      set({ selectedAgentId: id });
    },
    setDraftProjectId: (id) => {
      if (id) storage.setItem(wsKey(DRAFT_PROJECT_KEY), id);
      else storage.removeItem(wsKey(DRAFT_PROJECT_KEY));
      set({ draftProjectId: id });
    },
    setInputDraft: (sessionId, draft) => {
      // Debug level — onUpdate fires on every keystroke.
      logger.debug("setInputDraft", { sessionId, length: draft.length });
      const next = { ...get().inputDrafts, [sessionId]: draft };
      writeDrafts(storage, wsKey(DRAFTS_KEY), next);
      set({ inputDrafts: next });
    },
    clearInputDraft: (sessionId) => {
      const current = get().inputDrafts;
      if (!(sessionId in current) && !(sessionId in get().inputDraftAttachments)) {
        logger.debug("clearInputDraft skipped (no draft)", { sessionId });
        return;
      }
      logger.info("clearInputDraft", { sessionId });
      const next = { ...current };
      delete next[sessionId];
      const nextAttachments = { ...get().inputDraftAttachments };
      const nextDetails = { ...get().localAttachmentDetails };
      for (const id of Object.values(nextAttachments[sessionId] ?? {})) delete nextDetails[id];
      delete nextAttachments[sessionId];
      writeDrafts(storage, wsKey(DRAFTS_KEY), next);
      writeDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY), nextAttachments);
      set({ inputDrafts: next, inputDraftAttachments: nextAttachments, localAttachmentDetails: nextDetails });
    },
    setInputDraftAttachment: (draftKey, url, attachmentId) => {
      const current = get().inputDraftAttachments;
      const next = { ...current, [draftKey]: { ...current[draftKey], [url]: attachmentId } };
      writeDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY), next);
      set({ inputDraftAttachments: next });
    },
    setLocalAttachmentDetail: (attachment) => set({ localAttachmentDetails: {
      ...get().localAttachmentDetails, [attachment.id]: attachment,
    } }),
    clearInputDraftAttachments: (draftKey) => {
      const next = { ...get().inputDraftAttachments };
      const nextDetails = { ...get().localAttachmentDetails };
      for (const id of Object.values(next[draftKey] ?? {})) delete nextDetails[id];
      delete next[draftKey];
      writeDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY), next);
      set({ inputDraftAttachments: next, localAttachmentDetails: nextDetails });
    },
    setChatSize: (w, h) => {
      logger.debug("setChatSize", { w, h });
      storage.setItem(CHAT_WIDTH_KEY, String(w));
      storage.setItem(CHAT_HEIGHT_KEY, String(h));
      // Dragging = user chose a manual size → exit expanded mode
      storage.removeItem(wsKey(CHAT_EXPANDED_KEY));
      set({ chatWidth: w, chatHeight: h, isExpanded: false });
    },
    setExpanded: (expanded) => {
      logger.info("setExpanded", { to: expanded });
      if (expanded) {
        storage.setItem(wsKey(CHAT_EXPANDED_KEY), "true");
      } else {
        storage.removeItem(wsKey(CHAT_EXPANDED_KEY));
      }
      set({ isExpanded: expanded });
    },
    setFollowUpMode: (mode) => {
      storage.setItem(FOLLOW_UP_MODE_KEY, mode);
      set({ followUpMode: mode });
    },
    startQueueEdit: (sessionId, edit) => {
      const state = get();
      const stash = state.queueEdit[sessionId]?.stash ?? {
        draft: state.inputDrafts[sessionId] ?? "",
        attachments: state.inputDraftAttachments[sessionId] ?? {},
      };
      const queueEdit = { ...state.queueEdit, [sessionId]: { itemId: edit.itemId, revision: edit.revision, stash } };
      const inputDrafts = { ...state.inputDrafts, [sessionId]: edit.body_md };
      const inputDraftAttachments = { ...state.inputDraftAttachments };
      if (Object.keys(edit.attachments).length) inputDraftAttachments[sessionId] = edit.attachments;
      else delete inputDraftAttachments[sessionId];
      logger.info("startQueueEdit", { sessionId, itemId: edit.itemId });
      writeJsonRecord(storage, wsKey(QUEUE_EDIT_KEY), queueEdit);
      writeDrafts(storage, wsKey(DRAFTS_KEY), inputDrafts);
      writeDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY), inputDraftAttachments);
      set({ queueEdit, inputDrafts, inputDraftAttachments });
    },
    finishQueueEdit: (sessionId, outcome, keptText) => {
      const state = get();
      const edit = state.queueEdit[sessionId];
      if (!edit) return;
      const queueEdit = { ...state.queueEdit };
      delete queueEdit[sessionId];
      const { draft, attachments } = edit.stash;
      const current = keptText ?? state.inputDrafts[sessionId] ?? "";
      const nextDraft = outcome === "restore" ? draft
        : [current.trim(), draft.trim()].filter(Boolean).join("\n\n");
      const nextAttachments = outcome === "restore" ? attachments
        : { ...attachments, ...state.inputDraftAttachments[sessionId] };
      const inputDrafts = { ...state.inputDrafts, [sessionId]: nextDraft };
      const inputDraftAttachments = { ...state.inputDraftAttachments };
      if (Object.keys(nextAttachments).length) inputDraftAttachments[sessionId] = nextAttachments;
      else delete inputDraftAttachments[sessionId];
      logger.info("finishQueueEdit", { sessionId, itemId: edit.itemId, outcome });
      writeJsonRecord(storage, wsKey(QUEUE_EDIT_KEY), queueEdit);
      writeDrafts(storage, wsKey(DRAFTS_KEY), inputDrafts);
      writeDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY), inputDraftAttachments);
      set({ queueEdit, inputDrafts, inputDraftAttachments });
    },
    putQueueOutboxItem: (sessionId, item) => {
      const current = get().queueOutbox;
      const items = [...(current[sessionId] ?? []).filter((entry) => entry.client_id !== item.client_id), item]
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const queueOutbox = { ...current, [sessionId]: items };
      writeJsonRecord(storage, wsKey(QUEUE_OUTBOX_KEY), queueOutbox);
      set({ queueOutbox });
    },
    removeQueueOutboxItem: (sessionId, clientId, workspaceSlug) => {
      if (workspaceSlug !== undefined && workspaceSlug !== getCurrentSlug()) {
        const key = workspaceSlug ? `${QUEUE_OUTBOX_KEY}:${workspaceSlug}` : QUEUE_OUTBOX_KEY;
        const stored = readQueueOutbox(storage, key);
        const items = (stored[sessionId] ?? []).filter((entry) => entry.client_id !== clientId);
        if (items.length === (stored[sessionId]?.length ?? 0)) return;
        if (items.length) stored[sessionId] = items;
        else delete stored[sessionId];
        writeJsonRecord(storage, key, stored);
        return;
      }
      const current = get().queueOutbox;
      if (!current[sessionId]?.some((entry) => entry.client_id === clientId)) return;
      const items = current[sessionId]!.filter((entry) => entry.client_id !== clientId);
      const queueOutbox = { ...current };
      if (items.length) queueOutbox[sessionId] = items;
      else delete queueOutbox[sessionId];
      writeJsonRecord(storage, wsKey(QUEUE_OUTBOX_KEY), queueOutbox);
      set({ queueOutbox });
    },
    restoreToDraft: (sessionId, body, attachments) => {
      const state = get();
      const join = (draft: string) => [draft.trim(), body].filter(Boolean).join("\n\n");
      const edit = state.queueEdit[sessionId];
      if (edit) {
        const queueEdit = { ...state.queueEdit, [sessionId]: { ...edit, stash: {
          draft: join(edit.stash.draft), attachments: { ...edit.stash.attachments, ...attachments },
        } } };
        writeJsonRecord(storage, wsKey(QUEUE_EDIT_KEY), queueEdit);
        set({ queueEdit });
        return;
      }
      const inputDrafts = { ...state.inputDrafts, [sessionId]: join(state.inputDrafts[sessionId] ?? "") };
      const merged = { ...state.inputDraftAttachments[sessionId], ...attachments };
      const inputDraftAttachments = { ...state.inputDraftAttachments };
      if (Object.keys(merged).length) inputDraftAttachments[sessionId] = merged;
      writeDrafts(storage, wsKey(DRAFTS_KEY), inputDrafts);
      writeDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY), inputDraftAttachments);
      set({ inputDrafts, inputDraftAttachments });
    },
    openSubagentPanel: (target) => set({ subagentPanel: { ...target, path: [...target.path] } }),
    setSubagentPath: (path) => {
      const panel = get().subagentPanel;
      if (panel) set({ subagentPanel: { ...panel, path: [...path] } });
    },
    closeSubagentPanel: () => {
      if (get().subagentPanel || get().subagentReveal) set({ subagentPanel: null, subagentReveal: null });
    },
    revealSubagent: (attemptId, itemId) => set({ subagentReveal: { attemptId, itemId, nonce: ++revealNonce } }),
    clearQueueState: (sessionId) => {
      const state = get();
      if (!(sessionId in state.queueEdit) && !(sessionId in state.queueOutbox)) return;
      const queueEdit = { ...state.queueEdit };
      const queueOutbox = { ...state.queueOutbox };
      delete queueEdit[sessionId];
      delete queueOutbox[sessionId];
      writeJsonRecord(storage, wsKey(QUEUE_EDIT_KEY), queueEdit);
      writeJsonRecord(storage, wsKey(QUEUE_OUTBOX_KEY), queueOutbox);
      set({ queueEdit, queueOutbox });
    },
  }));

  registerForWorkspaceRehydration(() => {
    const nextSession = storage.getItem(wsKey(SESSION_STORAGE_KEY));
    const nextAgent = storage.getItem(wsKey(AGENT_STORAGE_KEY));
    const nextDrafts = readDrafts(storage, wsKey(DRAFTS_KEY));
    logger.info("workspace rehydration", {
      prevSession: store.getState().activeSessionId,
      nextSession,
      prevAgent: store.getState().selectedAgentId,
      nextAgent,
      draftCount: Object.keys(nextDrafts).length,
    });
    store.setState({
      activeSessionId: nextSession,
      selectedAgentId: nextAgent,
      draftProjectId: storage.getItem(wsKey(DRAFT_PROJECT_KEY)),
      inputDrafts: nextDrafts,
      inputDraftAttachments: readDraftAttachments(storage, wsKey(DRAFT_ATTACHMENTS_KEY)),
      localAttachmentDetails: {},
      queueEdit: readQueueEdits(storage, wsKey(QUEUE_EDIT_KEY)),
      queueOutbox: readQueueOutbox(storage, wsKey(QUEUE_OUTBOX_KEY)),
      // Another workspace's chats never show this one's panel.
      subagentPanel: null,
      subagentReveal: null,
    });
  });

  return store;
}
