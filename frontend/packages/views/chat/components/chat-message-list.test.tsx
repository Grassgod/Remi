import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { chatKeys } from "@multiremi/core/chat/queries";
import type { Attachment, ChatMessage, ChatPendingTask } from "@multiremi/core/types";
import type { TaskMessagePayload } from "@multiremi/core/types/events";

// jsdom has no layout, so the real Virtuoso measures a 0-height viewport and
// renders nothing. Render every row (plus Footer, which owns the live timeline
// and the status pill) inline instead.
//
// The mock reproduces Virtuoso's `firstItemIndex` contract, which the real
// component relies on: `itemContent` receives the *logical* index, i.e. the data
// index plus the offset (`react-virtuoso` adds `firstItemIndex` before calling
// the renderer). A mock that passed the data index would hide any bug keyed on
// logical indices — which is exactly how `data-perf-anchor="latest-message"`
// silently never rendered for months of green tests.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent, firstItemIndex = 0, components }: {
    data: ChatMessage[];
    itemContent: (index: number, item: ChatMessage) => ReactNode;
    firstItemIndex?: number;
    components?: { Footer?: () => ReactNode };
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={item.id}>{itemContent(index + firstItemIndex, item)}</div>
      ))}
      {components?.Footer ? <components.Footer /> : null}
    </div>
  ),
}));

vi.mock("../../i18n", () => ({ useT: () => ({ t: () => "" }) }));

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

const TASK_ID = "task_01hzzzzzzzzzzzzzzzzzzzzzzz";
const TIMELINE_TEXT = "Timeline answer from the task transcript.";

const taskMessages: TaskMessagePayload[] = [
  { task_id: TASK_ID, issue_id: "", seq: 1, type: "text", content: TIMELINE_TEXT },
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
  firstItemIndex = 0,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Seed the transcript the way useRealtimeSync does during the run, so no
  // component in the tree needs to fetch.
  client.setQueryData(chatKeys.taskMessages(TASK_ID), taskMessages);
  return render(
    <QueryClientProvider client={client}>
      <ChatMessageList
        messages={messages}
        pendingTask={pending}
        availability={undefined}
        firstItemIndex={firstItemIndex}
      />
    </QueryClientProvider>,
  );
}

describe("ChatMessageList measurement contract", () => {
  it("marks exactly one terminal anchor, on the last message, despite the firstItemIndex offset", () => {
    // ChatWindow passes firstItemIndex = 1_000_000 - olderMessageCount, so
    // `itemContent`'s index is offset. Keying the anchor on the logical index made
    // it never render; keying it on the message id is what this pins.
    const { container } = renderList(
      [attachmentPush("msg-1", "first"), terminalReply("msg-2")],
      null,
      1_000_000,
    );

    const anchors = container.querySelectorAll('[data-perf-anchor="latest-message"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("data-perf-key")).toBe("msg-2");

    // Every message still carries the row contract.
    expect(container.querySelectorAll('[data-perf-item="message"]')).toHaveLength(2);
  });

  it("has no terminal anchor when there are no messages", () => {
    const { container } = renderList([], null, 1_000_000);
    expect(container.querySelectorAll('[data-perf-anchor="latest-message"]')).toHaveLength(0);
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
});
