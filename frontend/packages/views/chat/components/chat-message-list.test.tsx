import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "@multiremi/contracts/trace";
import type { Attachment, ChatMessage, ChatPendingTask } from "@multiremi/core/types";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { MemorySessionReplica, type SessionLogEntry } from "@multiremi/core/replica";
import { setApiInstance } from "@multiremi/core/api";

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
vi.mock("../../issues/components/comment-card", () => ({
  AttachmentList: ({ attachments }: { attachments?: Attachment[] }) => (
    <div data-testid="attachment-list">{attachments?.length ?? 0}</div>
  ),
}));
vi.mock("./task-status-pill", () => ({
  TaskStatusPill: () => <div data-testid="status-pill" />,
}));

import { ChatMessageList } from "./chat-message-list";

describe("cached message observer visibility", () => {
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

  it.each(["live", "assistant"])("keeps the %s task observer inactive while hidden and refetches after opening", async (kind) => {
    const taskId = "tsk_visibility";
    const getTaskTrace = vi.fn(async () => ({ events: [], eof: true, state: "ok", next_after_seq: 0 }));
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
      await waitFor(() => expect(getTaskTrace).toHaveBeenCalledTimes(1));
      view.rerender(content(false));
      expect(getTaskTrace).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); client.clear(); }
  });
});

const TASK_ID = "task_01hzzzzzzzzzzzzzzzzzzzzzzz";
const TIMELINE_TEXT = "Timeline answer from the task transcript.";

const taskEvents: TraceEvent[] = [
  { seq: 1, ts: "2026-09-16T00:00:00Z", type: "text", content: TIMELINE_TEXT },
];

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
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["task-trace", TASK_ID], taskEvents);
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
  it("keeps the running task's status visible after an attachment push lands", () => {
    renderList([attachmentPush("msg-1", "Here is the report.")], pendingTask);

    // The push is not the reply: the live timeline and the pill must survive.
    expect(screen.getByTestId("status-pill")).toBeInTheDocument();
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

  it("draws the timeline once when a push and its terminal reply share a task id", () => {
    renderList([attachmentPush("msg-1", "Here is the report."), terminalReply("msg-2")], null);

    expect(screen.getAllByText(TIMELINE_TEXT)).toHaveLength(1);
    expect(screen.getByText("Here is the report.")).toBeInTheDocument();
  });

  it("still renders the timeline for an ordinary reply that carries attachments", () => {
    // A terminal reply is identified by elapsed_ms / failure_reason, so files
    // hanging off one must not demote it to a side-channel push.
    const reply = { ...terminalReply("msg-1"), attachments: [attachment("att-x")] };
    renderList([reply], null);

    expect(screen.getAllByText(TIMELINE_TEXT)).toHaveLength(1);
  });

  it("keeps a nonterminal turn without attachments separate from the final reply", () => {
    const push = { ...attachmentPush("msg-1", "Progress update"), attachments: [] };
    renderList([push, terminalReply("msg-2")], null);
    expect(screen.getByText("Progress update")).toBeInTheDocument();
    expect(screen.getAllByText(TIMELINE_TEXT)).toHaveLength(1);
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
