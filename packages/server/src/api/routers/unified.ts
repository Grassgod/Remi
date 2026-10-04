import type { Context, Hono } from "hono";
import { unlink } from "node:fs/promises";
import { MESSAGE_KINDS, TURN_STATUSES, type SendMessageInput, type UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import { chatAttachmentValidationError } from "@multiremi/contracts/attachments.js";
import { compatibilityInboxScope, denyAttachmentAccess, denyCurrentUserWorkspaceAccess, canUserViewTaskMessages } from "../helpers/auth-guards.js";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import { loadConversation, messageActor, messageResponse } from "../helpers/conversations.js";
import { persistUploadedAttachments, detectContentTypeFromFilename, safeFilename, uploadedAttachmentPath } from "../helpers/uploads.js";
import { currentTaskAccessToken, currentRequestUserId } from "../wire/context.js";
import { parseTraceWindow } from "../trace/request.js";
import type { RouterDeps } from "./deps.js";
import { IssueDecisionError } from "@multiremi/store/repos/issues-repo.js";

class InputError extends Error {}
function number(value: unknown, fallback?: number): number | undefined {
  if (value == null) return fallback;
  if (typeof value !== "number" && typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(String(value))) throw new InputError("invalid sequence or limit");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new InputError("invalid sequence or limit");
  return result;
}
function limit(c: Context) {
  const n = number(c.req.query("limit"), 100)!;
  if (n < 1 || n > 500) throw new InputError("limit must be between 1 and 500");
  return n;
}
function cursor(c: Context): { created_at: string; id: string } | undefined {
  const raw = c.req.query("cursor");
  if (raw == null) return;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at))
      || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    return { created_at: parsed.created_at, id: parsed.id };
  } catch { throw new InputError("invalid cursor"); }
}
const encodeCursor = (value: { created_at: string; id: string } | null) => value ? Buffer.from(JSON.stringify(value)).toString("base64url") : null;
async function body(c: Context): Promise<Record<string, any>> {
  try {
    const raw = await c.req.text();
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new InputError("invalid JSON body"); }
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InputError("expected boolean");
  return value;
}
async function action(c: Context, run: () => unknown | Promise<unknown>): Promise<Response> {
  try { return c.json(await run()); }
  catch (error) {
    if (error instanceof InputError) return c.json({ error: error.message }, 400);
    if (error instanceof IssueDecisionError) return c.json({ error: error.message }, error.status);
    if (error instanceof Error && /consumed|settled|running turn|retry|terminal|cancelled|pending attempt/i.test(error.message)) return c.json({ error: error.message }, 409);
    if (error instanceof Error && /not found|another workspace|recipient|required|within the log|Reply target|Source turn|Decision requires|attachment/i.test(error.message)) return c.json({ error: error.message }, 400);
    throw error;
  }
}

export function registerUnifiedRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  const callerTurn = (c: Context) => {
    const token = currentTaskAccessToken(c);
    if (!token?.taskId) return undefined;
    const turn = store.getTurnForAttempt(token.taskId);
    if (!turn || turn.current_attempt_id !== token.taskId) throw new InputError("source attempt is no longer current");
    return turn.id;
  };
  const publicMessage = (message: UnifiedMessage) => ({ ...messageResponse(message),
    attachments: [...(store.listAttachmentsForComments([message.id]).get(message.id) ?? []), ...(store.listAttachmentsForChatMessages([message.id]).get(message.id) ?? [])],
    reactions: store.listCommentReactionsForComments([message.id]).get(message.id) ?? [],
  });
  const loadMessage = (c: Context) => {
    const message = store.getMessage(c.req.param("id")!);
    if (!message || message.visibility !== "shown") return c.json({ error: "message not found" }, 404);
    const conversation = loadConversation(c, store, message.session_id);
    return conversation instanceof Response ? conversation : { message, conversation };
  };
  app.get("/api/sessions/:sessionId/messages", async (c, next) => {
    if (c.req.query("from") != null || c.req.query("to") != null) return next();
    const conversation = loadConversation(c, store, c.req.param("sessionId"));
    if (conversation instanceof Response) return conversation;
    return action(c, () => {
      const n = limit(c), rawCursor = c.req.query("cursor"), after = number(rawCursor ?? c.req.query("after_seq"), 0)!;
      if (rawCursor != null && c.req.query("after_seq") != null) throw new InputError("cursor and after_seq are mutually exclusive");
      const kind = c.req.query("message_kind"), unread = c.req.query("unread_by");
      if (kind && !MESSAGE_KINDS.includes(kind as any)) throw new InputError("invalid message_kind");
      if (unread && store.getAgent(unread)?.workspaceId !== conversation.workspaceId) throw new InputError("invalid unread_by");
      const thread = c.req.query("thread");
      if (thread && store.getMessage(thread)?.session_id !== conversation.id) throw new InputError("invalid thread");
      const rows = store.listMessages(conversation.id, { from: after, limit: n + 1, thread, unread_by: unread, message_kind: kind });
      return { messages: rows.slice(0, n).map(publicMessage), next_cursor: rows.length > n ? String(rows[n - 1]!.seq) : null };
    });
  });
  app.post("/api/sessions/:sessionId/messages", async (c) => {
    const conversation = loadConversation(c, store, c.req.param("sessionId"));
    if (conversation instanceof Response) return conversation;
    const sender = messageActor(c, store, conversation.workspaceId);
    if (sender instanceof Response) return sender;
    return action(c, async () => {
      let input: Record<string, any>, files: File[] = [];
      if (c.req.header("Content-Type")?.startsWith("multipart/form-data")) {
        try {
          const form = await c.req.formData();
          input = JSON.parse(String(form.get("message")));
          files = form.getAll("file").map(file => { if (!(file instanceof File)) throw new InputError("invalid file field"); return file; });
        } catch { throw new InputError("invalid multipart message"); }
      } else input = await body(c);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("invalid message");
      const kind = input.message_kind ?? (input.reply_to_id ? "reply" : "request"), wake = input.wake_requested ?? "now";
      if (!MESSAGE_KINDS.includes(kind) || !["now", "next_turn", "inbox_only"].includes(wake)) throw new InputError("invalid kind or wake");
      if (input.body_md != null && typeof input.body_md !== "string") throw new InputError("body_md must be a string");
      for (const key of ["reply_to_id", "dedupe_key"]) if (input[key] != null && (typeof input[key] !== "string" || !input[key].trim())) throw new InputError(`invalid ${key}`);
      const to = input.to ?? { type: "none" };
      if (!to || !["none", "agent", "member", "role"].includes(to.type)
        || to.type !== "none" && (typeof to.ref !== "string" || !to.ref.trim())
        || to.type === "role" && !["leader", "parent_owner", "delegator", "issue_owner", "relay"].includes(to.ref)) throw new InputError("invalid recipient");
      if (to.type === "agent" || to.type === "member") {
        const target = to.type === "agent" ? store.getAgent(to.ref) : store.getWorkspaceMember(to.ref);
        if (!target || target.workspaceId !== conversation.workspaceId) throw new InputError("recipient not found");
      }
      const options = input.options;
      if (options != null && (kind !== "decision" || !Array.isArray(options) || options.some((o: any) => !o || typeof o.label !== "string" || !o.label.trim() || typeof o.value !== "string" || !o.value.trim()))) throw new InputError("invalid decision options");
      const selected = input.metadata?.selected_options;
      if (selected != null && (!Array.isArray(selected) || selected.some((s: unknown) => typeof s !== "string"))) throw new InputError("invalid selected_options");
      if (input.response != null && (typeof input.response !== "object" || Array.isArray(input.response))) throw new InputError("invalid decision response");
      const text = input.body_md ?? "";
      if (!text.trim() && !files.length && !selected?.length && !input.attachment_ids?.length) throw new InputError("message content is required");
      const reply = input.reply_to_id ? store.getMessage(input.reply_to_id) : null;
      if (input.reply_to_id && (!reply || reply.session_id !== conversation.id || reply.deleted_at)) throw new InputError("invalid reply target");
      if (selected?.length && (!reply || reply.message_kind !== "decision" || reply.options && selected.some((s: string) => !reply.options!.some(o => o.value === s)))) throw new InputError("invalid selected option");
      if (reply?.message_kind === "decision" && kind === "reply") {
        if (files.length || input.attachment_ids?.length) throw new InputError("decision answers cannot include attachments");
        const result = store.answerMessageDecision(reply.id, { sender, body_md: text || selected.join("\n"), source_turn_id: callerTurn(c),
          response: input.response ?? (selected?.length ? { selected_options: selected, answer: text || selected.join("\n") } : undefined) });
        return { ...result, message: publicMessage(result.message) };
      }
      const attachmentIds = input.attachment_ids ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.some((id: unknown) => typeof id !== "string")) throw new InputError("invalid attachment_ids");
      for (const id of attachmentIds) {
        const attachment = store.getAttachment(id);
        if (!attachment || attachment.workspaceId !== conversation.workspaceId || denyAttachmentAccess(c, store, attachment)) throw new InputError("attachment not found");
      }
      for (const file of files) { const error = chatAttachmentValidationError(file.name, file.size); if (error) throw new InputError(error); }
      const sendInput: SendMessageInput = { session_id: conversation.id, sender, to, body_md: text, message_kind: kind, wake_requested: wake,
        reply_to_id: input.reply_to_id, dedupe_key: input.dedupe_key, options, attachment_ids: attachmentIds, source_turn_id: callerTurn(c) };
      const unusedUploads: Array<{ workspaceId: string; id: string; filename: string }> = [];
      const result = files.length ? await persistUploadedAttachments(conversation.workspaceId, files.map(file => ({ filename: safeFilename(file.name),
        bytes: async () => new Uint8Array(await file.arrayBuffer()), contentType: file.type || detectContentTypeFromFilename(file.name) })),
        uploads => {
          const sent = store.sendMessage(sendInput, uploads.map(upload => ({ ...upload, uploaderType: sender.type, uploaderId: sender.id })));
          for (const upload of uploads) if (!store.getAttachment(upload.id!)) unusedUploads.push({ workspaceId: conversation.workspaceId, id: upload.id!, filename: upload.filename });
          return sent;
        }) : store.sendMessage(sendInput);
      await Promise.all(unusedUploads.map(upload => unlink(uploadedAttachmentPath(upload))));
      return { ...result, message: publicMessage(result.message) };
    });
  });
  app.get("/api/messages/:id", c => {
    const loaded = loadMessage(c);
    return loaded instanceof Response ? loaded : c.json({ message: publicMessage(loaded.message) });
  });
  for (const method of ["PATCH", "DELETE"] as const) app.on(method, "/api/messages/:id", async c => {
    const loaded = loadMessage(c);
    if (loaded instanceof Response) return loaded;
    const actor = messageActor(c, store, loaded.conversation.workspaceId);
    if (actor instanceof Response) return actor;
    if (actor.type !== loaded.message.sender_type || actor.id !== loaded.message.sender_id) return c.json({ error: "only the sender may edit or delete" }, 403);
    return action(c, async () => {
      if (method === "DELETE") return { message: publicMessage(store.deleteMessage(loaded.message.id)) };
      const input = await body(c);
      if (typeof input.body_md !== "string" || !input.body_md.trim()) throw new InputError("body_md is required");
      return { message: publicMessage(store.editMessage(loaded.message.id, { body_md: input.body_md })) };
    });
  });
  for (const operation of ["resolve", "reactions"] as const) app.post(`/api/messages/:id/${operation}`, async c => {
    const loaded = loadMessage(c);
    if (loaded instanceof Response) return loaded;
    const actor = messageActor(c, store, loaded.conversation.workspaceId);
    if (actor instanceof Response) return actor;
    return action(c, async () => {
      const input = await body(c);
      if (operation === "resolve") return { message: publicMessage(store.resolveMessage(loaded.message.id, actor, boolean(input.resolved, true))) };
      if (typeof input.emoji !== "string" || !input.emoji.trim() || input.emoji.length > 64) throw new InputError("emoji is required");
      store.reactMessage(loaded.message.id, { emoji: input.emoji, actorType: actor.type, actorId: actor.id!, remove: boolean(input.remove, false) });
      return { reactions: store.listCommentReactionsForComments([loaded.message.id]).get(loaded.message.id) ?? [] };
    });
  });

  const inboxScope = (c: Context) => {
    const token = currentTaskAccessToken(c);
    if (!token) { const scope = compatibilityInboxScope(c, store); return scope instanceof Response ? scope : { ...scope, type: "member" as const, readerId: scope.memberId }; }
    const workspaceId = resolveRequestWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const actor = messageActor(c, store, workspaceId);
    return actor instanceof Response ? actor : { workspaceId, type: "agent" as const, readerId: actor.id! };
  };
  app.get("/api/inbox", c => {
    const scope = inboxScope(c);
    if (scope instanceof Response) return scope;
    return action(c, () => {
      const options = { limit: limit(c), cursor: cursor(c), visible: (id: string) => !(loadConversation(c, store, id) instanceof Response) };
      const page = scope.type === "member" ? store.listMessageInbox(scope.readerId, scope.workspaceId, options) : store.listReaderMessageInbox("agent", scope.readerId, scope.workspaceId, options);
      return { ...page, items: page.items.map(publicMessage), next_cursor: encodeCursor(page.next_cursor) };
    });
  });
  app.post("/api/inbox/read", async c => {
    const scope = inboxScope(c);
    if (scope instanceof Response) return scope;
    return action(c, async () => {
      const input = await body(c);
      if (boolean(input.all, false)) {
        if (input.session_id != null || input.to_seq != null) throw new InputError("all cannot be combined with session_id or to_seq");
        const visible = (id: string) => !(loadConversation(c, store, id) instanceof Response);
        return { conversations_read: scope.type === "member" ? store.readAllMessageInbox(scope.readerId, scope.workspaceId, visible) : store.readAgentMessageInbox(scope.readerId, scope.workspaceId, undefined, undefined, visible) };
      }
      if (typeof input.session_id !== "string") throw new InputError("session_id is required");
      const conversation = loadConversation(c, store, input.session_id);
      if (conversation instanceof Response || conversation.workspaceId !== scope.workspaceId) throw new InputError("conversation not found");
      const seq = number(input.to_seq);
      return { session_id: input.session_id, cursor_seq: scope.type === "member" ? store.readMessageInbox(scope.readerId, input.session_id, seq) : store.readAgentMessageInbox(scope.readerId, scope.workspaceId, input.session_id, seq) };
    });
  });

  const loadTurn = (c: Context) => {
    const turn = store.getTurn(c.req.param("id")!);
    if (!turn) return c.json({ error: "turn not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, turn.workspace_id);
    if (denied) return denied;
    const conversation = loadConversation(c, store, turn.session_id);
    if (conversation instanceof Response) return conversation;
    const task = turn.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
    if (task && !canUserViewTaskMessages(store, currentRequestUserId(c), task)) return c.json({ error: "turn not found" }, 404);
    return turn;
  };
  app.get("/api/turns", c => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return action(c, () => {
      const n = limit(c), status = c.req.query("status"), issueRef = c.req.query("issue"), issue = issueRef ? store.getIssueByRef(issueRef) : null;
      if (issueRef && (!issue || issue.workspaceId !== workspaceId)) throw new InputError("issue not found");
      if (status && !TURN_STATUSES.includes(status as any)) throw new InputError("invalid status");
      const sessionId = c.req.query("session_id") ?? c.req.query("chat");
      if (sessionId && loadConversation(c, store, sessionId) instanceof Response) throw new InputError("conversation not found");
      let after = cursor(c);
      const turns = [];
      while (turns.length <= n) {
        const chunk = store.listTurns({ workspace_id: workspaceId, issue_id: issue?.id, session_id: sessionId, agent_id: c.req.query("agent"), status, limit: n + 1, cursor: after });
        for (const turn of chunk) {
          const task = turn.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
          if (!(loadConversation(c, store, turn.session_id) instanceof Response) && (!task || canUserViewTaskMessages(store, currentRequestUserId(c), task))) turns.push(turn);
        }
        if (chunk.length < n + 1 || turns.length > n) break;
        after = chunk.at(-1);
      }
      return { turns: turns.slice(0, n), next_cursor: turns.length > n ? encodeCursor(turns[n - 1]!) : null };
    });
  });
  app.get("/api/turns/:id", c => {
    const turn = loadTurn(c);
    if (turn instanceof Response) return turn;
    return action(c, () => {
      for (const key of ["input", "attempts"]) if (c.req.query(key) != null && !["true", "false"].includes(c.req.query(key)!)) throw new InputError(`invalid ${key}`);
      const input = c.req.query("input") === "true" ? store.getTurnInput(turn.id) : null;
      return { turn, ...(input ? { input: { ...input, messages: input.messages.map(publicMessage) } } : {}),
        ...(c.req.query("attempts") === "true" ? { attempts: store.listTurnAttempts(turn.id) } : {}) };
    });
  });
  for (const operation of ["cancel", "wrap-up", "retry"] as const) app.post(`/api/turns/:id/${operation}`, async c => {
    const turn = loadTurn(c);
    if (turn instanceof Response) return turn;
    const token = currentTaskAccessToken(c);
    if (token && token.agentId !== turn.agent_id) return c.json({ error: "only this turn's agent may control it" }, 403);
    return action(c, async () => {
      const input = await body(c);
      return { turn: operation === "cancel" ? store.cancelTurn(turn.id) : operation === "wrap-up" ? store.wrapUpTurn(turn.id) : store.retryTurn(turn.id, boolean(input.cold, false)) };
    });
  });
  app.get("/api/turns/:id/trace", async c => {
    const turn = loadTurn(c);
    if (turn instanceof Response) return turn;
    const window = parseTraceWindow(c);
    if (!window) return c.json({ error: "invalid trace window" }, 400);
    const attemptId = c.req.query("attempt_id") ?? turn.current_attempt_id;
    if (!attemptId || !store.listTurnAttempts(turn.id).some(a => a.id === attemptId)) return c.json({ error: "attempt not found" }, 404);
    return c.json({ turn_id: turn.id, attempt_id: attemptId, ...await deps.traceReader.readTrace(attemptId, window.afterSeq, window.limit) });
  });
}
