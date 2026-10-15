import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Attachment, ChatMessage, ChatPendingTask } from "@multiremi/core/types";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { MemorySessionReplica, openBrowserReplica, type SessionLogEntry } from "@multiremi/core/replica";
import { setApiInstance } from "@multiremi/core/api";
import type { OptimisticChatRow } from "../lib/optimistic-log";
import { useTraceStreamSubscription } from "@multiremi/core/realtime";
import { paths } from "@multiremi/core/paths";
import type { TraceItem } from "@multiremi/contracts/trace";
import { at, command, message as traceMessage, permission, read, subagent, traceTurn, turnPage, turnTraceCache } from "../../test/trace-fixtures";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";

const { copiedText } = vi.hoisted(() => ({ copiedText: vi.fn().mockResolvedValue(true) }));
vi.mock("@multiremi/ui/lib/clipboard", () => ({ copyText: copiedText }));

vi.mock("@multiremi/core/realtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/realtime")>(),
  useTraceStreamSubscription: vi.fn(),
}));

vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "" }) }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_type: string, id: string) => id }) }));

vi.mock("@multiremi/core/paths", async importOriginal => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("test") };
});

// The markdown pipeline and the attachment cards are exercised by their own
// suites; here they only need to make their input assertable.
vi.mock("../../common/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <span>{children}</span>,
}));
vi.mock("../../common/question-card", async importOriginal => ({
  ...await importOriginal<typeof import("../../common/question-card")>(),
  UnifiedQuestionCard: ({ question }: { question: { id: string } }) => <div data-testid="original-question-card">Original question {question.id}</div>,
}));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("../../issues/components/comment-card", () => ({
  AttachmentList: ({ attachments }: { attachments?: Attachment[] }) => (
    <div data-testid="attachment-list">{attachments?.length ?? 0}</div>
  ),
}));
vi.mock("./task-status-pill", () => ({
  TaskStatusPill: () => <div data-testid="status-pill" />,
}));

import { ChatMessageList } from "./chat-message-list";

// Subagent rows open the panel through the chat store (PR 5).
const storeValues = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => storeValues.get(key) ?? null,
  setItem: (key, value) => { storeValues.set(key, value); },
  removeItem: (key) => { storeValues.delete(key); },
} }));

describe("cached message observer visibility", () => {
  it("renders one original Q, retains its answer body and source link, and renders an explicit cross-session notification", async () => {
    const getQuestion = vi.fn(async (id: string) => ({ kind: "question", id, session_id: "cs-1", workspace_id: "ws-1", source_issue_id: null, source_agent_id: "agent-1",
      source_turn_id: null, source_attempt_id: null, original_questions: [], original_message: "Native original question", options: null, summary: null,
      current_handler: { type: "member", id: "member-1" }, stage: "human", route_revision: 1, route_reason: null, answer_revision: 0, status: "pending",
      wait_status: "waiting", wait_reason: null, answer: null, history: [], actions: { allowed: ["answer"] } }));
    setApiInstance({ getQuestion } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rows = [
      { id: "q_original", seq: 1, sender_type: "agent", message_kind: "decision", body_md: "Native original question", metadata: { question: { version: 1 } } },
      { id: "answer", seq: 2, sender_type: "member", message_kind: "reply", body_md: "Continue with the accepted answer", metadata: { root_question_id: "q_original", human_response: { answers: { question: "Continue" } }, question_route_revision: 1 } },
    ].map(row => ({ session_id: "cs-1", revision: 1, kind: "message", body_html: null, render_version: null, ...row })) as SessionLogEntry[];
    const replica = new MemorySessionReplica({ "cs-1": { entries: rows } });
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} /></QueryClientProvider>);
    try {
      // The summary line loads its Q on mount; the full card stays in the drawer.
      await waitFor(() => expect(view.container.querySelector('[data-question-summary="q_original"] [data-question-tag]')).not.toBeNull());
      expect(view.container.querySelectorAll("[data-question-summary]")).toHaveLength(1);
      expect(screen.queryByTestId("original-question-card")).toBeNull();
      expect(getQuestion).toHaveBeenCalledWith("q_original");
      fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!);
      await waitFor(() => expect(screen.getAllByTestId("original-question-card")).toHaveLength(1));
      expect(screen.getByText("Continue with the accepted answer")).toBeTruthy();
      expect([...view.container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toContain(`${paths.workspace("test").inboxItem("q_original")}&question=q_original`);
      expect(getQuestion).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); client.clear(); }
    const noticeClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const notice = new MemorySessionReplica({ "cs-notice": { entries: [{ ...rows[0], session_id: "cs-notice", id: "notification", metadata: { root_question_id: "q_original", question_notification: true } } as SessionLogEntry] } });
    const noticeView = render(<QueryClientProvider client={noticeClient}><ChatMessageList sessionId="cs-notice" replica={notice} optimisticRows={[]} pendingTask={null} availability={undefined} /></QueryClientProvider>);
    try {
      expect(screen.queryByTestId("original-question-card")).toBeNull();
      await waitFor(() => expect(noticeView.container.querySelector('[data-question-summary="q_original"] [data-question-tag]')).not.toBeNull());
      fireEvent.click(noticeView.container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!);
      await waitFor(() => expect(screen.getAllByTestId("original-question-card")).toHaveLength(1));
    }
    finally { noticeView.unmount(); noticeClient.clear(); }
  });

  it("never repeats a Chat Q through a member reminder that sits beside it", async () => {
    const getQuestion = vi.fn(async () => { throw new Error("not needed"); });
    setApiInstance({ getQuestion } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rows = [
      { id: "plain", seq: 1, sender_type: "agent", message_kind: "message", body_md: "Ordinary agent message", metadata: {} },
      { id: "reminder", seq: 2, sender_type: "system", message_kind: "request", body_md: "Reminder body", to_type: "member", to_member_id: "member-1",
        metadata: { root_question_id: "q_original", question_notification: true } },
    ].map(row => ({ session_id: "cs-1", revision: 1, kind: "message", body_html: null, render_version: null, ...row })) as SessionLogEntry[];
    const replica = new MemorySessionReplica({ "cs-1": { entries: rows } });
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} /></QueryClientProvider>);
    try {
      await waitFor(() => expect(screen.getByText("Ordinary agent message")).toBeTruthy());
      expect(view.container.querySelector("[data-question-summary]")).toBeNull();
      expect(screen.queryByText("Reminder body")).toBeNull();
      expect(getQuestion).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });
  it("keeps a pinned Chat at the bottom when an availability banner changes layout, but leaves released scrolling alone", () => {
    const client = new QueryClient();
    const replica = new MemorySessionReplica({ "cs-1": { entries: [] } });
    const content = (availability: "offline" | "unstable" | undefined) => <QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]}
        pendingTask={null} availability={availability} />
    </QueryClientProvider>;
    const view = render(content(undefined));
    const root = view.container.querySelector<HTMLElement>('[data-perf-scroll="session-log"]')!;
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 500 });
    root.dataset.stickState = "pinned";
    view.rerender(content("offline"));
    expect(root.scrollTop).toBe(500);
    root.dataset.stickState = "released";
    root.scrollTop = 42;
    view.rerender(content("unstable"));
    expect(root.scrollTop).toBe(42);
    view.unmount(); client.clear();
  });

  it("does not load older log rows while the window is hidden", () => {
    const client = new QueryClient();
    const replica = new MemorySessionReplica({ "cs-1": { entries: [] } });
    const load = vi.fn();
    const content = (visible: boolean) => <QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]}
        pendingTask={null} availability={undefined} visible={visible}
        hasOlderMessages onLoadOlderMessages={load} />
    </QueryClientProvider>;
    const view = render(content(false));
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("[data-chat-earlier]")!);
    expect(load).not.toHaveBeenCalled();
    view.rerender(content(true));
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("[data-chat-earlier]")!);
    expect(load).toHaveBeenCalledTimes(1);
    view.unmount(); client.clear();
  });

  it.each(["live", "assistant"])("loads only a visible live task, keeps terminal reply trace lazy (%s)", async (kind) => {
    const taskId = "tsk_visibility";
    const getTaskTrace = vi.fn(async () => turnPage(traceTurn({ id: taskId }), []));
    setApiInstance({ getTaskTrace } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const entries = kind === "assistant" ? [{ session_id: "cs-1", seq: 1, id: "msg-1", revision: 1,
      kind: "turn", author_type: "agent", body_md: "Cached reply", body_html: null,
      render_version: null, task_id: taskId, metadata: { attachments: [], elapsed_ms: 1, final_reply_md: "Cached reply" },
      created_at: "2026-09-16T00:00:00Z" } as SessionLogEntry] : [];
    const replica = new MemorySessionReplica({ "cs-1": { entries } });
    const content = (visible: boolean) => <QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]}
        pendingTask={kind === "live" ? { task_id: taskId, status: "running" } as ChatPendingTask : null}
        availability={undefined} visible={visible} />
    </QueryClientProvider>;
    const view = render(content(false));
    try {
      expect(getTaskTrace).not.toHaveBeenCalled();
      view.rerender(content(true));
      if (kind === "live") await waitFor(() => expect(getTaskTrace).toHaveBeenCalledTimes(1));
      else expect(getTaskTrace).not.toHaveBeenCalled();
      view.rerender(content(false));
      expect(getTaskTrace).toHaveBeenCalledTimes(kind === "live" ? 1 : 0);
    } finally { view.unmount(); client.clear(); }
  });
});

const TASK_ID = "task_01hzzzzzzzzzzzzzzzzzzzzzzz";
const TIMELINE_TEXT = "Timeline answer from the task transcript.";

const liveTraceCache = turnTraceCache(turnPage(traceTurn({ id: TASK_ID }), [traceMessage("msg:1", TIMELINE_TEXT, "final")], { closed: false }));

function attachment(id: string): Attachment {
  return { id, url: `/api/attachments/${id}/content`, filename: `${id}.png` } as Attachment;
}

/** Mid-run push: carries the running task's id, a caption, and files. */
function attachmentPush(id: string, caption: string): ChatMessage {
  return {
    id,
    chat_session_id: "cs-1",
    role: "assistant",
    content: caption,
    task_id: TASK_ID,
    created_at: "2026-09-16T00:00:00.000Z",
    attachments: [attachment(`att-${id}`)],
    elapsed_ms: null,
    failure_reason: null,
  };
}

/** Terminal reply written by CompleteTask — the row that owns the timeline. */
function terminalReply(id: string): ChatMessage {
  return {
    id,
    chat_session_id: "cs-1",
    role: "assistant",
    content: "Task completed.",
    task_id: TASK_ID,
    created_at: "2026-09-16T00:00:10.000Z",
    elapsed_ms: 10_000,
  };
}

const pendingTask = { task_id: TASK_ID, status: "running" } as ChatPendingTask;

function renderList(
  messages: ChatMessage[],
  pending: ChatPendingTask | null,
  includeHead = false,
  traceCache: unknown = liveTraceCache,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (traceCache) client.setQueryData(["task-trace", TASK_ID], traceCache);
  const entries = messages.map((message, index) => ({
    session_id: "cs-1", seq: index + 1, id: message.id, revision: 1,
    kind: message.role === "user" ? "message" : "turn",
    author_type: message.role === "user" ? "member" : "agent",
    body_md: message.content, body_html: null, render_version: null,
    task_id: message.task_id,
    metadata: { final_reply_md: message.content, attachments: message.attachments,
      elapsed_ms: message.elapsed_ms, failure_reason: message.failure_reason },
    created_at: message.created_at,
  })) as SessionLogEntry[];
  if (includeHead) entries.unshift({ session_id: "cs-1", seq: 0, id: "chat-head", revision: 1,
    kind: "head", body_md: "Chat title", body_html: null, render_version: null } as SessionLogEntry);
  const replica = new MemorySessionReplica({ "cs-1": { entries } });
  return render(
    <QueryClientProvider client={client}>
      <ChatMessageList
        sessionId="cs-1"
        replica={replica}
        optimisticRows={[]}
        pendingTask={pending}
        availability={undefined}
      />
    </QueryClientProvider>,
  );
}

describe("ChatMessageList measurement contract", () => {
  it("removes a canonical body on a real fields.deleted_at frame and keeps it absent after reconnect and reload", async () => {
    const client = new QueryClient();
    const message = SessionLogEntrySchema.parse({ session_id: "cs-1", seq: 1, id: "msg-delete",
      revision: 1, kind: "message", sender_type: "member", sender_id: "user", message_kind: "request",
      body_md: "N2 deleted body", body_html: null, render_version: null });
    const subscribe = vi.fn();
    const replica = await openBrowserReplica({ userId: "user", workspaceId: "ws-1", tabId: "n2",
      subscribe, unsubscribe: vi.fn(), readRange: async () => [message],
      env: { hasOpfs: false, locks: {} as never } });
    replica.open("cs-1");
    replica.ack("cs-1", { stream: "log", id: "cs-1", first_seq: 1, head_seq: 1, log_version: 1, gap: null });
    replica.frames("cs-1", [{ seq: 1, kind: "entry", payload: message }]);
    const content = () => <QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica.port} optimisticRows={[]}
        pendingTask={null} availability={undefined} />
    </QueryClientProvider>;
    const view = render(content());
    try {
      expect(view.container).toHaveTextContent("N2 deleted body");
      act(() => replica.frames("cs-1", [{ seq: 1, kind: "patch", payload: { session_id: "cs-1",
        target_seq: 1, revision: 2, fields: { deleted_at: "2026-10-06T00:00:00Z" } } }]));
      expect(view.container).not.toHaveTextContent("N2 deleted body");
      act(() => {
        replica.resubscribe("cs-1");
        replica.frames("cs-1", [1, 2].map(revision => ({ seq: 1, kind: "entry", payload: { ...message, revision } })));
      });
      await act(() => replica.loadWindow("cs-1", { from: 1, to: 1 }));
      expect(view.container).not.toHaveTextContent("N2 deleted body");
      expect(replica.port.getSnapshot("cs-1").entries).toEqual([]);
      view.unmount();
      const refreshed = render(content());
      expect(refreshed.container).not.toHaveTextContent("N2 deleted body");
      refreshed.unmount();
    } finally { view.unmount(); replica.dispose(); client.clear(); }
  });

  it("hides canonical tombstones supplied by a refreshed log window", () => {
    const client = new QueryClient();
    const deleted = SessionLogEntrySchema.parse({ session_id: "cs-1", seq: 1, id: "msg-deleted-window",
      revision: 2, kind: "message", sender_type: "member", sender_id: "user", message_kind: "request",
      body_md: "Deleted window body", body_html: null, render_version: null, deleted_at: "2026-10-06T00:00:00Z" });
    const replica = new MemorySessionReplica({ "cs-1": { entries: [deleted] } });
    const view = render(<QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} />
    </QueryClientProvider>);
    expect(view.container).not.toHaveTextContent("Deleted window body");
    expect(view.container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(0);
    view.unmount(); client.clear();
  });

  it("shows canonical envelope messages, replaces edited bodies, removes deleted sends and survives reload", () => {
    const client = new QueryClient();
    const entry = (seq: number, body: string) => SessionLogEntrySchema.parse({ session_id: "cs-1", seq,
      id: `message-${seq}`, revision: 1, kind: "message", sender_type: "member", sender_id: "user",
      message_kind: "request", dedupe_key: `send-${seq}`, body_md: body, body_html: null,
      render_version: null, metadata: { envelope: { kind: "notification" } } });
    const first = entry(1, "BEFORE");
    const second = entry(2, "DELETE_ME");
    const replica = new MemorySessionReplica({ "cs-1": { entries: [first, second] } });
    const locals: OptimisticChatRow[] = [first, second].map(row => ({ clientId: row.dedupe_key!,
      sessionId: "cs-1", content: row.body_md, localSeq: row.seq, createdAt: "2026-10-05",
      status: "sent", confirmedAt: 100 }));
    const content = (optimisticRows: OptimisticChatRow[]) => <QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={optimisticRows}
        pendingTask={null} availability={undefined} />
    </QueryClientProvider>;
    const view = render(content(locals));
    expect(view.container).toHaveTextContent("BEFORE");
    expect(view.container).toHaveTextContent("DELETE_ME");
    act(() => replica.setWindow("cs-1", [{ ...first, revision: 2, body_md: "AFTER 中文 🧪" }], { head: 4 }));
    expect(view.container).toHaveTextContent("AFTER 中文 🧪");
    expect(view.container).not.toHaveTextContent(/BEFORE|DELETE_ME/);
    expect(view.container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(1);
    view.unmount();
    const reloaded = render(content([]));
    expect(reloaded.container).toHaveTextContent("AFTER 中文 🧪");
    expect(reloaded.container).not.toHaveTextContent(/BEFORE|DELETE_ME/);
    reloaded.unmount(); client.clear();
  });

  it("filters internal messages and future log kinds out of the row list", () => {
    const client = new QueryClient();
    const entries = ["message", "follow_frozen", "system", "result_published"].map((kind, index) => ({
      session_id: "cs-1", seq: index + 1, id: `event-${index}`, revision: 1, kind,
      author_type: "system", body_md: `# **Update ${index}** ises_123 tsk_123\nInternal second line`,
      body_html: "<h1>Internal heading</h1>", render_version: "v",
    }));
    const replica = new MemorySessionReplica({ "cs-1": { entries } });
    const view = render(<QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} />
    </QueryClientProvider>);
    expect(view.container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(0);
    expect(view.container).not.toHaveTextContent(/Update 0|Update 1/);
    expect(view.container).not.toHaveTextContent(/ises_|tsk_|Internal/);
    expect(view.container.querySelector("[data-entry-html]")).toBeNull();
    view.unmount(); client.clear();
  });

  it("hides inbox turns and envelopes even when their author is an agent", () => {
    const entries = [
      { session_id: "cs-1", seq: 1, id: "wake", revision: 1, kind: "turn", body_md: "读收件箱 ises_123", body_html: null, render_version: null, metadata: {} },
      { session_id: "cs-1", seq: 2, id: "envelope", revision: 1, kind: "turn", body_md: "Internal relay", body_html: null, render_version: null, author_type: "agent", metadata: { envelope: { kind: "report" } } },
    ];
    const client = new QueryClient();
    const replica = new MemorySessionReplica({ "cs-1": { entries } });
    const view = render(<QueryClientProvider client={client}>
      <ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} />
    </QueryClientProvider>);
    expect(view.container).not.toHaveTextContent(/ises_|读收件箱|Internal relay/);
    expect(view.container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(0);
    view.unmount(); client.clear();
  });

  it("marks exactly one terminal anchor on the last log row", () => {
    const { container } = renderList(
      [attachmentPush("msg-1", "first"), terminalReply("msg-2")],
      null,
    );

    const anchors = container.querySelectorAll('[data-perf-anchor="latest-message"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("data-perf-key")).toBe("msg-2");

    // Every message still carries the row contract.
    expect(container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(2);
  });

  it("has no terminal anchor when there are no messages", () => {
    const { container } = renderList([], null);
    expect(container.querySelectorAll('[data-perf-anchor="latest-message"]')).toHaveLength(0);
  });

  it("does not render Chat's seq 0 title as a message after client recovery", () => {
    const { container } = renderList([terminalReply("msg-1")], null, true);
    expect(container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(1);
    expect(container).not.toHaveTextContent("Chat title");
  });
});

describe("ChatMessageList with mid-run agent attachments", () => {
  it("shows the status pill only until the trace has a turn, then the steps fold speaks for the run", async () => {
    const noTurn = turnTraceCache(turnPage(null, [], { closed: false }));
    const view = renderList([], pendingTask, false, noTurn);
    expect(screen.getByTestId("status-pill")).toBeInTheDocument();
    expect(view.container.querySelector("[data-chat-live-turn]")).toBeNull();
    const callbacks = vi.mocked(useTraceStreamSubscription).mock.calls.at(-1)![1];
    await act(async () => {
      callbacks.onFrames?.([{ seq: 1, kind: "trace", payload: { seq: 1, ts: traceTurn().started_at, type: "turn.started", turn: traceTurn({ id: TASK_ID }) } }]);
    });
    await waitFor(() => expect(screen.queryByTestId("status-pill")).toBeNull());
    expect(view.container.querySelector('[data-chat-steps="live"]')).not.toBeNull();
    view.unmount();
  });

  it("hides the pill once the trace closes and keeps it for a legacy trace", async () => {
    const view = renderList([], pendingTask, false, turnTraceCache(turnPage(null, [], { closed: false })));
    const callbacks = vi.mocked(useTraceStreamSubscription).mock.calls.at(-1)![1];
    await act(async () => { callbacks.onClosed?.({ stream: "trace", id: TASK_ID, head_seq: 1 }); });
    await waitFor(() => expect(screen.queryByTestId("status-pill")).toBeNull());
    view.unmount();
    const legacy = renderList([], pendingTask, false, turnTraceCache(turnPage(null, [], { format: "legacy", closed: false })));
    expect(screen.getByTestId("status-pill")).toBeInTheDocument();
    expect(legacy.container.querySelector("[data-chat-live-turn]")).toBeNull();
    legacy.unmount();
  });

  it("keeps the pill when the live read fails", async () => {
    setApiInstance({ getTaskTrace: vi.fn().mockRejectedValue(new Error("offline")) } as never);
    const view = renderList([], pendingTask, false, null);
    await waitFor(() => expect(screen.getByRole("alert", { hidden: true })).toBeInTheDocument());
    expect(screen.getByTestId("status-pill")).toBeInTheDocument();
    view.unmount();
  });

  it.each([
    ["the server says the task waits for an answer", "awaiting_human", false],
    ["the trace shows an open permission", "running", true],
  ] as const)("shows the waiting pill beside the fold while %s", (_case, status, openPermission) => {
    const waiting: TraceItem[] = openPermission
      ? [{ ...permission("perm:1", "Bash"), status: "in_progress", completed_at: null, outcome: null }] : [];
    const cache = turnTraceCache(turnPage(traceTurn({ id: TASK_ID }), [command("cmd_1", [read("a.ts")]), ...waiting], { closed: false }));
    const view = renderList([], { ...pendingTask, status }, false, cache);
    expect(view.container.querySelector('[data-chat-steps="live"]')).not.toBeNull();
    expect(screen.getByTestId("status-pill")).toBeInTheDocument();
    view.unmount();
  });

  it("keeps and copies the complete persisted reply, then reads execution only on click", async () => {
    copiedText.mockClear();
    const getTaskTrace = vi.fn().mockResolvedValue(turnPage(traceTurn({ id: TASK_ID, status: "completed" }), []));
    const getTask = vi.fn().mockResolvedValue({ id: TASK_ID, agent_id: "", runtime_id: "", issue_id: "", status: "completed",
      priority: 0, created_at: "2026-10-05T00:00:00Z", started_at: null, dispatched_at: null, completed_at: null, result: null, error: null });
    setApiInstance({ getTaskTrace, getTask, getTaskPrompt: vi.fn().mockRejectedValue({ status: 404 }) } as never);
    const complete = "Full persisted reply\n\nIncluding the final paragraph that a first trace page cannot contain.";
    const view = renderList([{ ...terminalReply("lazy"), content: complete }], null);
    expect(screen.getByText(complete, { normalizer: value => value })).toBeInTheDocument();
    expect(getTaskTrace).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
    fireEvent.click(view.container.querySelector(".lucide-copy")!.closest("button")!);
    await waitFor(() => expect(copiedText).toHaveBeenCalledWith(complete));
    fireEvent.click(view.container.querySelector<HTMLButtonElement>("[data-chat-trace]")!);
    await waitFor(() => expect(getTask).toHaveBeenCalledWith(TASK_ID, undefined));
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith(TASK_ID, { itemCursor: 0, turnId: undefined }));
    view.unmount();
  });

  it("keeps raw failure details available without loading trace history", () => {
    const getTaskTrace = vi.fn();
    setApiInstance({ getTaskTrace } as never);
    const view = renderList([{ ...terminalReply("failed"), failure_reason: "agent_error", content: "Provider rejected the prompt" }], null);
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!);
    expect(screen.getByText("Provider rejected the prompt")).toBeInTheDocument();
    expect(getTaskTrace).not.toHaveBeenCalled();
    expect(view.container.querySelector("[data-chat-trace]")).toBeInTheDocument();
    view.unmount();
  });
  it("keeps the running task's live steps visible after an attachment push lands", () => {
    const view = renderList([attachmentPush("msg-1", "Here is the report.")], pendingTask);

    // The push is not the reply: the live turn must survive.
    expect(view.container.querySelector("[data-chat-live-turn]")).not.toBeNull();
    expect(screen.getAllByText(TIMELINE_TEXT)).toHaveLength(1);
  });

  it("retires the status once the terminal reply lands", () => {
    renderList([attachmentPush("msg-1", "Here is the report."), terminalReply("msg-2")], pendingTask);

    expect(screen.queryByTestId("status-pill")).not.toBeInTheDocument();
  });

  it("renders the push's own caption instead of the task timeline", () => {
    renderList([attachmentPush("msg-1", "Here is the report.")], pendingTask);

    expect(screen.getByText("Here is the report.")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-list")).toHaveTextContent("1");
  });

  it("uses the stored answer when a push and its terminal reply share a task id", () => {
    renderList([attachmentPush("msg-1", "Here is the report."), terminalReply("msg-2")], null);

    expect(screen.queryByText(TIMELINE_TEXT)).toBeNull();
    expect(screen.getByText("Task completed.")).toBeInTheDocument();
    expect(screen.getByText("Here is the report.")).toBeInTheDocument();
  });

  it("renders the stored answer for an ordinary reply that carries attachments", () => {
    // A terminal reply is identified by elapsed_ms / failure_reason, so files
    // hanging off one must not demote it to a side-channel push.
    const reply = { ...terminalReply("msg-1"), attachments: [attachment("att-x")] };
    renderList([reply], null);

    expect(screen.queryByText(TIMELINE_TEXT)).toBeNull();
    expect(screen.getByText("Task completed.")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-list")).toHaveTextContent("1");
  });

  it("keeps a nonterminal turn without attachments separate from the final reply", () => {
    const push = { ...attachmentPush("msg-1", "Progress update"), attachments: [] };
    renderList([push, terminalReply("msg-2")], null);
    expect(screen.getByText("Progress update")).toBeInTheDocument();
    expect(screen.queryByText(TIMELINE_TEXT)).toBeNull();
    expect(screen.getByText("Task completed.")).toBeInTheDocument();
  });
});

describe("canonical turn projection", () => {
  it("renders a persisted reply once and leaves attempts and historical trace lazy", () => {
    const getTaskTrace = vi.fn(); const getTurn = vi.fn();
    setApiInstance({ getTaskTrace, getTurn } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const entries = [
      { session_id: "cs-1", seq: 1, id: "turn_1", revision: 1, kind: "turn", task_id: "attempt_1", body_md: "", body_html: null, render_version: null,
        metadata: { turn_id: "turn_1", status: "completed", final_entry_id: "msg_reply", final_reply_md: "Canonical answer" } },
      { session_id: "cs-1", seq: 2, id: "msg_reply", revision: 1, kind: "message", sender_type: "agent", message_kind: "reply", task_id: "turn_1", body_md: "Canonical answer", body_html: null, render_version: null, metadata: {} },
    ].map(row => SessionLogEntrySchema.parse(row));
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1" replica={new MemorySessionReplica({ "cs-1": { entries } })} optimisticRows={[]} pendingTask={null} availability={undefined} /></QueryClientProvider>);
    expect(screen.getAllByText("Canonical answer")).toHaveLength(1);
    expect(getTaskTrace).not.toHaveBeenCalled(); expect(getTurn).not.toHaveBeenCalled();
    view.unmount(); client.clear();
  });
});

describe("Chat rows without the envelope header or attempts list", () => {
  const render2 = (rows: Record<string, unknown>[]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const entries = rows.map(row => SessionLogEntrySchema.parse({ session_id: "cs-1", revision: 1, body_html: null, render_version: null, ...row }));
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1"
      replica={new MemorySessionReplica({ "cs-1": { entries } })} optimisticRows={[]} pendingTask={null} availability={undefined} /></QueryClientProvider>);
    return { view, client };
  };

  it("drops the envelope header and keeps one hint only for a message that did not wake the agent", () => {
    setApiInstance({ getTurn: vi.fn() } as never);
    const { view, client } = render2([
      { seq: 1, id: "woke", kind: "message", sender_type: "member", sender_id: "user", message_kind: "request",
        to_type: "agent", to_ref: "agent-1", wake_applied: "now", wake_reason: "human_sender", body_md: "Woke the agent" },
      { seq: 2, id: "queued", kind: "message", sender_type: "member", sender_id: "user", message_kind: "request",
        to_type: "agent", to_ref: "agent-1", wake_applied: "next_turn", wake_reason: "requested_next_turn", body_md: "Waits for the next turn" },
    ]);
    try {
      expect(view.container).toHaveTextContent("Woke the agent");
      expect(view.container).toHaveTextContent("Waits for the next turn");
      expect(view.container.querySelector("[data-message-header]")).toBeNull();
      const hints = view.container.querySelectorAll("[data-wake-hint]");
      expect(hints).toHaveLength(1);
      expect(hints[0]).toHaveAttribute("data-wake-hint", "next_turn");
      expect(hints[0]!.closest('[data-perf-key="queued"]')).not.toBeNull();
    } finally { view.unmount(); client.clear(); }
  });

  it("renders a failed turn as a notice with warm and cold retry and a lazy execution log", async () => {
    const getTaskTrace = vi.fn(); const getTurn = vi.fn(); const getTask = vi.fn();
    const retryTurn = vi.fn().mockResolvedValue({ turn: { id: "turn_1" } });
    setApiInstance({ getTaskTrace, getTurn, getTask, retryTurn } as never);
    const { view, client } = render2([
      { seq: 1, id: "turn_1", kind: "turn", task_id: "attempt_1", body_md: "",
        metadata: { turn_id: "turn_1", status: "failed", failure_reason: "agent_error", final_reply_md: "Provider rejected the prompt" } },
    ]);
    try {
      const notice = view.container.querySelector('[data-turn-notice="failed"]')!;
      expect(notice).not.toBeNull();
      // No attempts list: the turn detail is never read for display.
      expect(getTurn).not.toHaveBeenCalled();
      expect(notice.querySelector("[data-chat-trace]")).not.toBeNull();
      fireEvent.click(notice.querySelector<HTMLButtonElement>('[data-turn-retry="warm"]')!);
      await waitFor(() => expect(retryTurn).toHaveBeenCalledWith("turn_1", false));
      fireEvent.click(notice.querySelector<HTMLButtonElement>('[data-turn-retry="cold"]')!);
      await waitFor(() => expect(retryTurn).toHaveBeenCalledWith("turn_1", true));
      // Raw details stay one click away and need no trace.
      fireEvent.click(notice.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!);
      expect(screen.getByText("Provider rejected the prompt")).toBeInTheDocument();
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(getTask).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it("shows a failed turn's outcome once, on its reply row", () => {
    setApiInstance({ getTaskTrace: vi.fn(), getTurn: vi.fn() } as never);
    const { view, client } = render2([
      { seq: 1, id: "turn_6", kind: "turn", task_id: "attempt_6", body_md: "Provider rejected the prompt",
        metadata: { turn_id: "turn_6", status: "failed", failure_reason: "agent_error", final_entry_id: "msg_failed", final_reply_md: "Provider rejected the prompt" } },
      { seq: 2, id: "msg_failed", kind: "message", sender_type: "agent", message_kind: "reply", task_id: "turn_6",
        body_md: "Provider rejected the prompt", metadata: { failure_reason: "agent_error", elapsed_ms: 1200 } },
    ]);
    try {
      const notices = view.container.querySelectorAll('[data-turn-notice="failed"]');
      expect(notices).toHaveLength(1);
      expect(notices[0]!.closest('[data-perf-key="msg_failed"]')).not.toBeNull();
      expect(view.container.querySelector('[data-perf-key="turn_6"]')).toBeNull();
      expect(view.container.querySelectorAll("[data-turn-retry]")).toHaveLength(2);
      fireEvent.click(notices[0]!.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!);
      expect(screen.getAllByText("Provider rejected the prompt")).toHaveLength(1);
    } finally { view.unmount(); client.clear(); }
  });

  it("marks a cancelled turn without a failure body and still offers retry", () => {
    setApiInstance({ getTaskTrace: vi.fn(), getTurn: vi.fn() } as never);
    const { view, client } = render2([
      { seq: 1, id: "turn_2", kind: "turn", task_id: "attempt_2", body_md: "", metadata: { turn_id: "turn_2", status: "cancelled", failure_reason: null } },
    ]);
    try {
      const notice = view.container.querySelector('[data-turn-notice="cancelled"]')!;
      expect(notice).not.toBeNull();
      expect(notice.querySelectorAll("[data-turn-retry]")).toHaveLength(2);
      expect(notice.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
    } finally { view.unmount(); client.clear(); }
  });

  it("shows a finished turn's reply with no status text and a quiet execution log that loads only on click", async () => {
    const getTaskTrace = vi.fn().mockResolvedValue({ events: [], head: 0, next_after_seq: 0, eof: true, closed: true, source: "daemon", state: "ok" });
    const getTurn = vi.fn();
    const getTask = vi.fn().mockResolvedValue({ id: "attempt_3", agent_id: "", runtime_id: "", issue_id: "", status: "completed",
      priority: 0, created_at: "2026-10-05T00:00:00Z", started_at: null, dispatched_at: null, completed_at: null, result: null, error: null });
    setApiInstance({ getTaskTrace, getTurn, getTask, getTaskPrompt: vi.fn().mockRejectedValue({ status: 404 }) } as never);
    const { view, client } = render2([
      { seq: 1, id: "turn_3", kind: "turn", task_id: "attempt_3", body_md: "Finished answer",
        metadata: { turn_id: "turn_3", status: "completed", final_reply_md: "Finished answer", elapsed_ms: 1000 } },
      { seq: 2, id: "turn_4", kind: "turn", task_id: "attempt_4", body_md: "",
        metadata: { turn_id: "turn_4", status: "completed", final_entry_id: "msg_reply" } },
      { seq: 3, id: "msg_reply", kind: "message", sender_type: "agent", message_kind: "reply", task_id: "turn_4", body_md: "Separate reply" },
    ]);
    try {
      expect(screen.getByText("Finished answer")).toBeInTheDocument();
      expect(screen.getAllByText("Separate reply")).toHaveLength(1);
      expect(view.container).not.toHaveTextContent("completed");
      expect(view.container.querySelector("[data-turn-notice]")).toBeNull();
      // The card of a turn whose reply is loaded leaves no empty row above the reply.
      expect(view.container.querySelector('[data-perf-key="turn_4"]')).toBeNull();
      const logs = view.container.querySelectorAll<HTMLButtonElement>("[data-chat-trace]");
      expect(logs).toHaveLength(2);
      // The reply row carries its card's execution log.
      expect(logs[1]!.closest('[data-perf-key="msg_reply"]')).not.toBeNull();
      // Hidden until the row is hovered or focused, but still in the tab order.
      for (const log of logs) expect(log.className).toContain("opacity-0");
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(getTask).not.toHaveBeenCalled();
      expect(getTurn).not.toHaveBeenCalled();
      fireEvent.click(logs[0]!);
      await waitFor(() => expect(getTask).toHaveBeenCalledWith("attempt_3", "turn_3"));
      fireEvent.click(logs[1]!);
      await waitFor(() => expect(getTask).toHaveBeenCalledWith("attempt_4", "turn_4"));
      expect(getTurn).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it("swaps the copy icon to a check for 1.5s after a successful copy", async () => {
    copiedText.mockClear();
    setApiInstance({ getTaskTrace: vi.fn() } as never);
    const { view, client } = render2([
      { seq: 1, id: "turn_5", kind: "turn", task_id: "attempt_5", body_md: "Copy me",
        metadata: { turn_id: "turn_5", status: "completed", final_reply_md: "Copy me" } },
    ]);
    try {
      const copy = view.container.querySelector<HTMLButtonElement>("[data-chat-copy]")!;
      expect(copy.className).toContain("opacity-0");
      fireEvent.click(copy);
      await waitFor(() => expect(view.container.querySelector('[data-chat-copy="copied"]')).not.toBeNull());
      expect(copiedText).toHaveBeenCalledWith("Copy me");
      await waitFor(() => expect(view.container.querySelector('[data-chat-copy="copied"]')).toBeNull(), { timeout: 2500 });
    } finally { view.unmount(); client.clear(); }
  });
});

describe("finished turn steps fold (MUL-472)", () => {
  const renderRows = (rows: Record<string, unknown>[]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const entries = rows.map(row => SessionLogEntrySchema.parse({ session_id: "cs-1", revision: 1, body_html: null, render_version: null, ...row }));
    const replica = new MemorySessionReplica({ "cs-1": { entries } });
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1"
      replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} /></QueryClientProvider>);
    return { view, client };
  };

  it("folds a counted turn's steps above its reply, collapsed, and reads the trace only when opened", async () => {
    const getTaskTrace = vi.fn().mockResolvedValue(turnPage(traceTurn({ id: "attempt_7", status: "completed" }), [traceMessage("msg:f", "Answer", "final")]));
    const getTurn = vi.fn();
    setApiInstance({ getTaskTrace, getTurn } as never);
    const { view, client } = renderRows([
      { seq: 1, id: "turn_7", kind: "turn", task_id: "attempt_7", body_md: "",
        metadata: { turn_id: "turn_7", status: "completed", final_entry_id: "msg_7", process_item_count: 3, worked_ms: 4000, elapsed_ms: 9000 } },
      { seq: 2, id: "msg_7", kind: "message", sender_type: "agent", message_kind: "reply", task_id: "turn_7", body_md: "Answer" },
      { seq: 3, id: "turn_8", kind: "turn", task_id: "attempt_8", body_md: "Old answer",
        metadata: { turn_id: "turn_8", status: "completed", final_reply_md: "Old answer", elapsed_ms: 1000 } },
    ]);
    try {
      const reply = view.container.querySelector<HTMLElement>('[data-perf-key="msg_7"]')!;
      const fold = reply.querySelector('[data-chat-steps="finished"]')!;
      expect(fold).not.toBeNull();
      const header = fold.querySelector<HTMLButtonElement>("[data-chat-steps-header]")!;
      expect(header).toHaveAttribute("aria-expanded", "false");
      // The fold carries the execution log, so the reply footer has none of its own.
      expect(reply.querySelector("[data-chat-trace]")).toBeNull();
      // An old card without a count gets no fold and keeps the quiet log button.
      const old = view.container.querySelector<HTMLElement>('[data-perf-key="turn_8"]')!;
      expect(old.querySelector("[data-chat-steps]")).toBeNull();
      expect(old.querySelector("[data-chat-trace]")).not.toBeNull();
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(getTurn).not.toHaveBeenCalled();
      fireEvent.click(header);
      await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("attempt_7", { itemCursor: 0, turnId: "turn_7" }));
      expect(getTaskTrace).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(reply.querySelector('[data-chat-steps="finished"] [data-chat-trace]')).not.toBeNull());
    } finally { view.unmount(); client.clear(); }
  });

  it("puts a failed turn's steps above its failure notice and keeps the notice's own log button", () => {
    const getTaskTrace = vi.fn();
    setApiInstance({ getTaskTrace, getTurn: vi.fn() } as never);
    const { view, client } = renderRows([
      { seq: 1, id: "turn_9", kind: "turn", task_id: "attempt_9", body_md: "",
        metadata: { turn_id: "turn_9", status: "failed", failure_reason: "agent_error", process_item_count: 2, elapsed_ms: 5000 } },
    ]);
    try {
      const row = view.container.querySelector<HTMLElement>('[data-perf-key="turn_9"]')!;
      const fold = row.querySelector('[data-chat-steps="finished"]')!;
      const notice = row.querySelector('[data-turn-notice="failed"]')!;
      expect(fold.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(notice.querySelector("[data-chat-trace]")).not.toBeNull();
      expect(getTaskTrace).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it("puts a finished turn's late subagents under its reply from the card, reading no trace until one opens (PR 5 §6.4)", () => {
    const getTaskTrace = vi.fn();
    const getTurn = vi.fn();
    setApiInstance({ getTaskTrace, getTurn } as never);
    useChatStore.getState().closeSubagentPanel();
    const late = [
      { item_id: "sa:explore", name: "Explore", status: "completed", duration_ms: 24_000 },
      { item_id: "sa:plan", name: "Plan", status: "failed", duration_ms: null },
      { item_id: "bad" },
    ];
    const { view, client } = renderRows([
      { seq: 1, id: "turn_11", kind: "turn", task_id: "attempt_11", body_md: "",
        metadata: { turn_id: "turn_11", status: "completed", final_entry_id: "msg_11", process_item_count: 2, worked_ms: 4000, late_subagents: late } },
      { seq: 2, id: "msg_11", kind: "message", sender_type: "agent", message_kind: "reply", task_id: "turn_11", body_md: "Answer" },
      { seq: 3, id: "turn_12", kind: "turn", task_id: "attempt_12", body_md: "Older",
        metadata: { turn_id: "turn_12", status: "completed", final_reply_md: "Older", process_item_count: 1 } },
    ]);
    try {
      const reply = view.container.querySelector<HTMLElement>('[data-perf-key="msg_11"]')!;
      const rows = [...reply.querySelectorAll<HTMLButtonElement>("[data-subagent-late-row]")];
      // Malformed entries are dropped; the rows sit under the reply text.
      expect(rows.map((row) => [row.getAttribute("data-subagent-late-row"), row.getAttribute("data-late-status")]))
        .toEqual([["sa:explore", "completed"], ["sa:plan", "failed"]]);
      expect(screen.getByText("Answer").compareDocumentPosition(rows[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // An older card without the field shows none.
      expect(view.container.querySelector('[data-perf-key="turn_12"] [data-subagent-late]')).toBeNull();
      expect(getTaskTrace).not.toHaveBeenCalled();
      expect(getTurn).not.toHaveBeenCalled();
      fireEvent.click(rows[1]!);
      expect(useChatStore.getState().subagentPanel).toEqual({ sessionId: "cs-1", attemptId: "attempt_11", turnId: "turn_11", live: false, path: ["sa:plan"] });
      // The list itself still reads nothing; the panel reads on open.
      expect(getTaskTrace).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it("shows no fold for a turn that counted no process items", () => {
    setApiInstance({ getTaskTrace: vi.fn() } as never);
    const { view, client } = renderRows([
      { seq: 1, id: "turn_10", kind: "turn", task_id: "attempt_10", body_md: "Hi",
        metadata: { turn_id: "turn_10", status: "completed", final_reply_md: "Hi", process_item_count: 0, worked_ms: 100 } },
    ]);
    try {
      expect(view.container.querySelector("[data-chat-steps]")).toBeNull();
      expect(view.container.querySelector("[data-chat-trace]")).not.toBeNull();
    } finally { view.unmount(); client.clear(); }
  });
});

describe("live turn steps", () => {
  it("renders the running turn's fold and final reply from its live trace, then yields to the persisted reply", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["task-trace", TASK_ID], turnTraceCache(turnPage(traceTurn({ id: TASK_ID }), [
      command("cmd_1", [read("a.ts")]),
      traceMessage("msg:f", "Streaming answer", "final", { status: "in_progress", completed_at: null }),
    ], { closed: false })));
    const replica = new MemorySessionReplica({ "cs-1": { entries: [] } });
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]}
      pendingTask={pendingTask} availability={undefined} /></QueryClientProvider>);
    try {
      expect(view.container.querySelector('[data-chat-steps="live"]')).not.toBeNull();
      expect(view.container.querySelector("[data-chat-live-final]")).toHaveTextContent("Streaming answer");
      // The fold carries the run; the pill would only repeat it.
      expect(screen.queryByTestId("status-pill")).toBeNull();
      // No subagent runs: no strip.
      expect(view.container.querySelector("[data-subagent-strip]")).toBeNull();
    } finally { view.unmount(); client.clear(); }
  });

  it("pins the running strip to the top of the list while a subagent of the live turn runs (PR 5 §6.5)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["task-trace", TASK_ID], turnTraceCache(turnPage(traceTurn({ id: TASK_ID }), [
      subagent("sa:1", "Explore", { name: "Explore", background: true, status: "in_progress", completed_at: null, started_at: at(1) }),
    ], { closed: false })));
    const replica = new MemorySessionReplica({ "cs-1": { entries: [] } });
    const view = render(<QueryClientProvider client={client}><ChatMessageList sessionId="cs-1" replica={replica} optimisticRows={[]}
      pendingTask={pendingTask} availability={undefined} /></QueryClientProvider>);
    try {
      const strip = view.container.querySelector<HTMLElement>("[data-subagent-strip]")!;
      expect(strip.className).toContain("sticky");
      expect(strip.querySelector('[data-strip-chip="sa:1"]')).not.toBeNull();
      // Its row in the live fold opens the panel on the live attempt.
      fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-chat-live-turn] [data-subagent-row="sa:1"]')!);
      expect(useChatStore.getState().subagentPanel).toMatchObject({ sessionId: "cs-1", attemptId: TASK_ID, live: true, path: ["sa:1"] });
    } finally { view.unmount(); client.clear(); }
  });
});
