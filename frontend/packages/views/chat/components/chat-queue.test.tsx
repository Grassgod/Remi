import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatQueue as ChatQueueData, QueuedChatMessage } from "@multiremi/core/chat/queue";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
import { chatKeys } from "@multiremi/core/chat/queries";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { renderWithI18n } from "../../test/i18n";

const mock = vi.hoisted(() => ({
  getChatQueue: vi.fn(), steerQueuedChatMessage: vi.fn(), deleteQueuedChatMessage: vi.fn(),
  updateQueuedChatMessage: vi.fn(), resumeChatQueue: vi.fn(), enqueueChatMessage: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(() => "toast-1"), { error: vi.fn(), dismiss: vi.fn() }));
vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(), api: mock,
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("sonner", () => ({ toast }));

import { ApiError } from "@multiremi/core/api";
import { ChatQueue, QUEUE_DELETE_UNDO_MS, QUEUE_PREVIEW_DELAY_MS, QUEUE_STALLED_GRACE_MS } from "./chat-queue";

const row = (fields: Partial<QueuedChatMessage> = {}): QueuedChatMessage => ({
  id: "qmsg_1", session_id: "chat_1", body_md: "Then run the\n\n   migration tests", attachments: [],
  client_id: "client-1", status: "queued", error: null, revision: 1, released_message_id: null,
  released_via: null, released_at: null, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z", ...fields,
});
let queue: ChatQueueData;
let client: QueryClient;

function mount(props: { pendingTaskId?: string | null; onReleased?: () => void } = {}) {
  const onReleased = props.onReleased ?? vi.fn();
  const view = renderWithI18n(
    <QueryClientProvider client={client}>
      <ChatQueue sessionId="chat_1" pendingTaskId={props.pendingTaskId === undefined ? "task_1" : props.pendingTaskId} onReleased={onReleased} />
    </QueryClientProvider>,
  );
  return { ...view, onReleased };
}


const STEER = /^Steer queued message \d+$/;
const RETRY = /^Retry queued message \d+$/;
const MORE = /^Actions for queued message \d+$/;

function openMenu(item: HTMLElement) {
  fireEvent.click(within(item).getByRole("button", { name: MORE }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  setCurrentWorkspace("acme", "ws-1");
  const values = new Map<string, string>();
  registerChatStore(createChatStore({ storage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  } }));
  queue = { items: [row()], paused: null };
  mock.getChatQueue.mockImplementation(async () => queue);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

describe("ChatQueue rows", () => {
  it("previews each row on one line, labels it with its position, and shows the full text after 700 ms", async () => {
    queue = { items: [row(), row({ id: "qmsg_2", client_id: "client-2", body_md: "x".repeat(120), attachments: [
      { id: "att_1", filename: "a.png", content_type: "image/png", size: 1 },
    ] })], paused: null };
    mount();
    const first = await screen.findByRole("listitem", { name: "Preview queued message 1: Then run the migration tests" });
    expect(within(first).getByText("Then run the migration tests")).toHaveClass("truncate");
    const second = screen.getByRole("listitem", { name: `Preview queued message 2: ${"x".repeat(79)}…` });
    expect(within(second).getByTitle("1 attachment")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Queued messages" })).toHaveClass("max-h-[30dvh]");

    const preview = within(first).getByText("Then run the migration tests");
    fireEvent.pointerEnter(preview, { pointerType: "mouse" });
    fireEvent.mouseEnter(preview);
    fireEvent.mouseMove(preview);
    await act(async () => { vi.advanceTimersByTime(QUEUE_PREVIEW_DELAY_MS - 50); });
    expect(screen.queryByText(/Then run the\s+migration tests/, { selector: "div.whitespace-pre-wrap" })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(await screen.findByText(/Then run the\s+migration tests/, { selector: "div.whitespace-pre-wrap" })).toBeInTheDocument();
  });

  it("renders nothing while the queue is empty", async () => {
    queue = { items: [], paused: null };
    const { container } = mount();
    await waitFor(() => expect(mock.getChatQueue).toHaveBeenCalledWith("chat_1"));
    expect(container).toBeEmptyDOMElement();
  });

  it("refetches when the running turn changes", async () => {
    const view = mount();
    await screen.findByRole("listitem", { name: /Preview queued message 1/ });
    expect(mock.getChatQueue).toHaveBeenCalledTimes(1);
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatQueue sessionId="chat_1" pendingTaskId="optimistic-x" />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(mock.getChatQueue).toHaveBeenCalledTimes(1);
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatQueue sessionId="chat_1" pendingTaskId={null} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mock.getChatQueue).toHaveBeenCalledTimes(2));
  });
});

describe("ChatQueue steer", () => {
  it("shows a sending row, then releases it and refreshes the conversation", async () => {
    let resolve!: (value: unknown) => void;
    mock.steerQueuedChatMessage.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { onReleased } = mount();
    const item = await screen.findByRole("listitem", { name: /Preview queued message 1/ });
    const steer = within(item).getByRole("button", { name: STEER });
    fireEvent.click(steer);
    await waitFor(() => expect(item).toHaveAttribute("aria-busy", "true"));
    expect(item).toHaveClass("opacity-60");
    expect(within(item).getByRole("img", { name: "Sending" })).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: MORE })).toBeDisabled();
    expect(mock.steerQueuedChatMessage).toHaveBeenCalledWith("chat_1", "qmsg_1");
    queue = { items: [], paused: null };
    await act(async () => { resolve({ item: row({ status: "released", released_via: "steer" }), message: { id: "msg_1" } }); });
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    expect(onReleased).toHaveBeenCalledOnce();
  });

  it("explains a row the turn already sent", async () => {
    mock.steerQueuedChatMessage.mockRejectedValue(new ApiError("sent", 409, "Conflict", { error: "sent", code: "queued_message_consumed" }));
    mount();
    fireEvent.click(within(await screen.findByRole("listitem", { name: /1:/ })).getByRole("button", { name: STEER }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("This message was already sent and can no longer be changed"));
  });

  it("keeps a steer without an HTTP answer unconfirmed and retries it only on request", async () => {
    mock.steerQueuedChatMessage.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount();
    const item = await screen.findByRole("listitem", { name: /1:/ });
    fireEvent.click(within(item).getByRole("button", { name: STEER }));
    await waitFor(() => expect(item).toHaveAttribute("data-state", "unconfirmed"));
    expect(within(item).getByRole("img", { name: /Delivery could not be confirmed/ })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(mock.steerQueuedChatMessage).toHaveBeenCalledTimes(1);
    mock.steerQueuedChatMessage.mockResolvedValueOnce({ item: row({ status: "released" }), message: { id: "msg_1" } });
    fireEvent.click(within(item).getByRole("button", { name: RETRY }));
    await waitFor(() => expect(mock.steerQueuedChatMessage).toHaveBeenCalledTimes(2));
  });

  it("shows a failed row with its remedy and retries it through resume", async () => {
    queue = { items: [row({ status: "failed", error: "agent archived" })], paused: { reason: "send_failed", at: "t" } };
    mock.resumeChatQueue.mockResolvedValue({ items: [], paused: null, released: [{ message: { id: "msg_1" } }] });
    const { onReleased } = mount();
    const item = await screen.findByRole("listitem", { name: /1:/ });
    expect(item).toHaveAttribute("data-state", "failed");
    expect(within(item).getByRole("img", {
      name: "This queued message could not be sent Retry, edit, or delete it to continue the queue",
    })).toBeInTheDocument();
    // A failed row carries the pause; no banner repeats it.
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(within(item).getByRole("button", { name: RETRY }));
    await waitFor(() => expect(mock.resumeChatQueue).toHaveBeenCalledWith("chat_1"));
    await waitFor(() => expect(onReleased).toHaveBeenCalledOnce());
  });
});

describe("ChatQueue edit", () => {
  it("loads the row into the composer draft with its attachment bindings and marks it editing", async () => {
    queue = { items: [row({ body_md: "See ![](/api/attachments/att_1/content)", attachments: [
      { id: "att_1", filename: "a.png", content_type: "image/png", size: 1 },
    ] })], paused: null };
    useChatStore.getState().setInputDraft("chat_1", "my own draft");
    mount();
    const item = await screen.findByRole("listitem", { name: /1:/ });
    openMenu(item);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit message" }));
    const state = useChatStore.getState();
    expect(state.queueEdit.chat_1).toEqual({ itemId: "qmsg_1", revision: 1, stash: { draft: "my own draft", attachments: {} } });
    expect(state.inputDrafts.chat_1).toBe("See ![](/api/attachments/att_1/content)");
    expect(state.inputDraftAttachments.chat_1).toEqual({ "/api/attachments/att_1/content": "att_1" });
    await waitFor(() => expect(item).toHaveAttribute("data-state", "editing"));
    expect(within(item).getByText("Editing")).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: STEER })).toBeDisabled();
  });

  it("keeps the edited text as a draft when the row leaves the queue mid-edit", async () => {
    mount();
    const item = await screen.findByRole("listitem", { name: /1:/ });
    act(() => useChatStore.getState().startQueueEdit("chat_1", { itemId: "qmsg_1", revision: 1, body_md: row().body_md, attachments: {} }));
    act(() => useChatStore.getState().setInputDraft("chat_1", "edited text"));
    expect(item).toBeInTheDocument();
    queue = { items: [], paused: null };
    await act(async () => { await client.invalidateQueries({ queryKey: chatKeys.queue("ws-1", "chat_1") }); });
    await waitFor(() => expect(useChatStore.getState().queueEdit).toEqual({}));
    expect(useChatStore.getState().inputDrafts.chat_1).toBe("edited text");
    expect(toast).toHaveBeenCalledWith("This queued message was sent or deleted. Your edit stays in the input.");
  });
});

describe("ChatQueue delete", () => {
  it("hides the row behind an undo toast and deletes after 5 s", async () => {
    mock.deleteQueuedChatMessage.mockImplementation(async () => {
      queue = { items: [], paused: null };
      return row({ status: "deleted" });
    });
    mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    expect(toast).toHaveBeenCalledWith("Queued message deleted", expect.objectContaining({ duration: QUEUE_DELETE_UNDO_MS }));
    // The fake clock also follows real time (shouldAdvanceTime), so leave a margin.
    await act(async () => { vi.advanceTimersByTime(QUEUE_DELETE_UNDO_MS - 500); });
    expect(mock.deleteQueuedChatMessage).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(mock.deleteQueuedChatMessage).toHaveBeenCalledWith("chat_1", "qmsg_1");
  });

  it("brings the row back on undo without deleting it", async () => {
    mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    const [, options] = toast.mock.calls.at(-1) as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(options.action.label).toBe("Undo");
    act(() => options.action.onClick());
    expect(await screen.findByRole("listitem", { name: /1:/ })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(QUEUE_DELETE_UNDO_MS * 2); });
    expect(mock.deleteQueuedChatMessage).not.toHaveBeenCalled();
  });

  it("sends a pending delete at once when the chat closes or switches", async () => {
    mock.deleteQueuedChatMessage.mockResolvedValue(row({ status: "deleted" }));
    const view = mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    view.unmount();
    await waitFor(() => expect(mock.deleteQueuedChatMessage).toHaveBeenCalledWith("chat_1", "qmsg_1"));
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("tells the user when the turn sent the row before its delete went out", async () => {
    mock.deleteQueuedChatMessage.mockRejectedValue(new ApiError("sent", 409, "Conflict", { error: "sent", code: "queued_message_consumed" }));
    mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    // The turn ends and releases the row while its undo is still showing.
    queue = { items: [], paused: null };
    await act(async () => { await client.invalidateQueries({ queryKey: chatKeys.queue("ws-1", "chat_1") }); });
    await waitFor(() => expect(mock.deleteQueuedChatMessage).toHaveBeenCalledWith("chat_1", "qmsg_1"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("This message was already sent before it could be deleted"));
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
    await act(async () => { vi.advanceTimersByTime(QUEUE_DELETE_UNDO_MS); });
    expect(mock.deleteQueuedChatMessage).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a row deleted elsewhere leaves the list during its undo", async () => {
    mock.deleteQueuedChatMessage.mockResolvedValue(row({ status: "deleted" }));
    mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    queue = { items: [], paused: null };
    await act(async () => { await client.invalidateQueries({ queryKey: chatKeys.queue("ws-1", "chat_1") }); });
    await waitFor(() => expect(mock.deleteQueuedChatMessage).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("dismisses the undo toast when the delete goes out, and a late Undo says it is too late", async () => {
    mock.deleteQueuedChatMessage.mockImplementation(async () => {
      queue = { items: [], paused: null };
      return row({ status: "deleted" });
    });
    mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    const [, options] = toast.mock.calls.at(-1) as unknown as [string, { action: { onClick: () => void } }];
    // Sonner pauses its own timer on hover; the delete still goes out on time.
    await act(async () => { vi.advanceTimersByTime(QUEUE_DELETE_UNDO_MS); });
    expect(mock.deleteQueuedChatMessage).toHaveBeenCalledOnce();
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
    act(() => options.action.onClick());
    expect(toast).toHaveBeenLastCalledWith("Already deleted; it can no longer be undone");
    await act(async () => {});
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("moves focus to the next row after a delete, then to the composer", async () => {
    queue = { items: [row(), row({ id: "qmsg_2", client_id: "client-2", body_md: "Second" })], paused: null };
    const view = renderWithI18n(
      <QueryClientProvider client={client}>
        <ChatQueue sessionId="chat_1" pendingTaskId="task_1" />
        <div data-chat-composer=""><div contentEditable="true" suppressContentEditableWarning data-testid="composer" /></div>
      </QueryClientProvider>,
    );
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Second"));
    openMenu(screen.getByRole("listitem", { name: /Second/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(document.activeElement).toBe(view.getByTestId("composer")));
  });

  it("shows the row again when the delete is refused", async () => {
    mock.deleteQueuedChatMessage.mockRejectedValue(new ApiError("nope", 403, "Forbidden", { error: "nope", code: "not_queued_message_sender" }));
    mount();
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await act(async () => { vi.advanceTimersByTime(QUEUE_DELETE_UNDO_MS); });
    expect(await screen.findByRole("listitem", { name: /1:/ })).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("Could not update the queue. Please try again.");
  });
});

describe("ChatQueue banners", () => {
  it("offers Resume after the user interrupted the run", async () => {
    queue = { items: [row()], paused: { reason: "interrupted", at: "t" } };
    mock.resumeChatQueue.mockImplementation(async () => {
      queue = { items: [], paused: null };
      return { items: [], paused: null, released: [{ message: { id: "msg_1" } }] };
    });
    const { onReleased } = mount({ pendingTaskId: null });
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Queue paused because you interrupted");
    fireEvent.click(within(banner).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mock.resumeChatQueue).toHaveBeenCalledWith("chat_1"));
    await waitFor(() => expect(onReleased).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
  });

  it("explains a run that did not finish", async () => {
    queue = { items: [row()], paused: { reason: "turn_ended", at: "t" } };
    mount({ pendingTaskId: null });
    expect(await screen.findByRole("status")).toHaveTextContent("Queue paused because the run did not finish");
  });

  it("detects stalled rows on an idle lane after a grace period, but not while a run is active", async () => {
    const view = mount({ pendingTaskId: "task_1" });
    await screen.findByRole("listitem", { name: /1:/ });
    await act(async () => { vi.advanceTimersByTime(QUEUE_STALLED_GRACE_MS * 2); });
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatQueue sessionId="chat_1" pendingTaskId={null} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mock.getChatQueue).toHaveBeenCalledTimes(2));
    await act(async () => { vi.advanceTimersByTime(QUEUE_STALLED_GRACE_MS - 100); });
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(await screen.findByRole("status")).toHaveTextContent("Queued messages have not been sent");
  });
});

describe("ChatQueue unconfirmed enqueue", () => {
  it("shows the local row with the delivery warning and retries with the same client id", async () => {
    queue = { items: [], paused: null };
    useChatStore.getState().putQueueOutboxItem("chat_1", {
      client_id: "client-9", body_md: "Saved locally", attachments: [], created_at: "2026-10-15T00:00:00Z", state: "unconfirmed",
    });
    mock.enqueueChatMessage.mockResolvedValue({ item: row({ id: "qmsg_9", client_id: "client-9", body_md: "Saved locally" }), released: null });
    mount();
    const item = await screen.findByRole("listitem", { name: "Preview queued message 1: Saved locally" });
    expect(within(item).getByRole("img", { name: /Delivery could not be confirmed/ })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(mock.enqueueChatMessage).not.toHaveBeenCalled();
    fireEvent.click(within(item).getByRole("button", { name: RETRY }));
    await waitFor(() => expect(mock.enqueueChatMessage).toHaveBeenCalledWith("chat_1", {
      body_md: "Saved locally", attachment_ids: undefined, client_id: "client-9",
    }));
    await waitFor(() => expect(useChatStore.getState().queueOutbox).toEqual({}));
  });

  it("drops the local row quietly when its server row was deleted elsewhere", async () => {
    queue = { items: [], paused: null };
    useChatStore.getState().putQueueOutboxItem("chat_1", {
      client_id: "client-9", body_md: "Saved locally", attachments: [], created_at: "t", state: "unconfirmed",
    });
    mock.enqueueChatMessage.mockRejectedValue(new ApiError("deleted", 409, "Conflict", { error: "deleted", code: "queued_message_deleted" }));
    mount();
    fireEvent.click(within(await screen.findByRole("listitem", { name: /Saved locally/ })).getByRole("button", { name: RETRY }));
    await waitFor(() => expect(useChatStore.getState().queueOutbox).toEqual({}));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("clears the local row once the server lists it", async () => {
    queue = { items: [row({ client_id: "client-9" })], paused: null };
    useChatStore.getState().putQueueOutboxItem("chat_1", {
      client_id: "client-9", body_md: "Saved locally", attachments: [], created_at: "t", state: "unconfirmed",
    });
    mount();
    await waitFor(() => expect(useChatStore.getState().queueOutbox).toEqual({}));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("ChatQueue review fixes", () => {
  it("sends deletes still behind their undo before resuming, so a deleted row is never released", async () => {
    queue = { items: [row(), row({ id: "qmsg_2", client_id: "client-2", body_md: "Keep me" })], paused: { reason: "interrupted", at: "t" } };
    const order: string[] = [];
    let finishDelete!: () => void;
    mock.deleteQueuedChatMessage.mockImplementation(() => new Promise((resolve) => {
      finishDelete = () => { order.push("delete"); resolve(row({ status: "deleted" })); };
    }));
    mock.resumeChatQueue.mockImplementation(async () => { order.push("resume"); return { items: [], paused: null, released: [] }; });
    mount({ pendingTaskId: null });
    openMenu(await screen.findByRole("listitem", { name: /1:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete queued message" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mock.deleteQueuedChatMessage).toHaveBeenCalledWith("chat_1", "qmsg_1"));
    expect(mock.resumeChatQueue).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
    await act(async () => { finishDelete(); });
    await waitFor(() => expect(order).toEqual(["delete", "resume"]));
  });

  it("keeps the stalled banner through background refetches of the same answer", async () => {
    let finishFetch: (() => void) | undefined;
    mount({ pendingTaskId: null });
    await screen.findByRole("listitem", { name: /1:/ });
    await act(async () => { vi.advanceTimersByTime(QUEUE_STALLED_GRACE_MS + 100); });
    expect(await screen.findByRole("status")).toHaveTextContent("Queued messages have not been sent");
    mock.getChatQueue.mockImplementation(() => new Promise((resolve) => { finishFetch = () => resolve(queue); }));
    let refetch!: Promise<unknown>;
    act(() => { refetch = client.refetchQueries({ queryKey: chatKeys.queue("ws-1", "chat_1") }); });
    await waitFor(() => expect(finishFetch).toBeDefined());
    expect(screen.getByRole("status")).toHaveTextContent("Queued messages have not been sent");
    await act(async () => { finishFetch!(); await refetch; });
    expect(screen.getByRole("status")).toHaveTextContent("Queued messages have not been sent");
  });

  it("puts a refused retry of an unconfirmed enqueue back into the composer", async () => {
    queue = { items: [], paused: null };
    useChatStore.getState().setInputDraft("chat_1", "draft");
    useChatStore.getState().putQueueOutboxItem("chat_1", {
      client_id: "client-9", body_md: "See ![](/api/attachments/att_9/content)", attachment_ids: ["att_9"],
      attachments: [{ id: "att_9", filename: "a.png", content_type: "image/png", size: 1 }], created_at: "t", state: "unconfirmed",
    });
    mock.enqueueChatMessage.mockRejectedValue(new ApiError("archived", 409, "Conflict", { error: "archived", code: "chat_archived" }));
    mount();
    fireEvent.click(within(await screen.findByRole("listitem", { name: /See/ })).getByRole("button", { name: RETRY }));
    await waitFor(() => expect(useChatStore.getState().inputDrafts.chat_1).toBe("draft\n\nSee ![](/api/attachments/att_9/content)"));
    expect(useChatStore.getState().inputDraftAttachments.chat_1).toEqual({ "/api/attachments/att_9/content": "att_9" });
    expect(useChatStore.getState().queueOutbox).toEqual({});
    expect(toast.error).toHaveBeenCalledWith("This chat is archived. Restore it to send queued messages.", {
      description: "This message could not be queued. Its text is back in the input.",
    });
  });

  it("keeps a steer answered by a gateway status unconfirmed", async () => {
    mock.steerQueuedChatMessage.mockRejectedValue(new ApiError("Bad Gateway", 502, "Bad Gateway"));
    mount();
    const item = await screen.findByRole("listitem", { name: /1:/ });
    fireEvent.click(within(item).getByRole("button", { name: STEER }));
    await waitFor(() => expect(item).toHaveAttribute("data-state", "unconfirmed"));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("allows one edit at a time", async () => {
    queue = { items: [row(), row({ id: "qmsg_2", client_id: "client-2", body_md: "Second" })], paused: null };
    mount();
    await screen.findByRole("listitem", { name: /1:/ });
    act(() => useChatStore.getState().startQueueEdit("chat_1", { itemId: "qmsg_1", revision: 1, body_md: "x", attachments: {} }));
    openMenu(screen.getByRole("listitem", { name: /Second/ }));
    expect(await screen.findByRole("menuitem", { name: "Edit message" })).toHaveAttribute("aria-disabled", "true");
  });

  it("names each row's actions by position and lets the keyboard reach the full text", async () => {
    queue = { items: [row(), row({ id: "qmsg_2", client_id: "client-2", body_md: "Second" })], paused: null };
    mount();
    const second = await screen.findByRole("listitem", { name: /Second/ });
    expect(within(second).getByRole("button", { name: "Steer queued message 2" })).toBeInTheDocument();
    expect(within(second).getByRole("button", { name: "Actions for queued message 2" })).toBeInTheDocument();
    expect(within(second).getByText("Second")).toHaveAttribute("tabindex", "0");
  });

  it("explains, instead of sending, while the Chat is archived", async () => {
    queue = { items: [row()], paused: { reason: "interrupted", at: "t" } };
    renderWithI18n(
      <QueryClientProvider client={client}>
        <ChatQueue sessionId="chat_1" pendingTaskId={null} archived />
      </QueryClientProvider>,
    );
    const item = await screen.findByRole("listitem", { name: /1:/ });
    const steer = within(item).getByRole("button", { name: STEER });
    const resume = within(screen.getByRole("status")).getByRole("button", { name: "Resume" });
    for (const button of [steer, resume]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
    }
    await act(async () => {});
    expect(mock.steerQueuedChatMessage).not.toHaveBeenCalled();
    expect(mock.resumeChatQueue).not.toHaveBeenCalled();
    fireEvent.pointerEnter(steer, { pointerType: "mouse" });
    fireEvent.mouseEnter(steer);
    fireEvent.mouseMove(steer);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(await screen.findByText("This chat is archived. Restore it to send queued messages.")).toBeInTheDocument();
    // Edit and delete still work in an archived Chat.
    openMenu(item);
    expect(await screen.findByRole("menuitem", { name: "Edit message" })).not.toHaveAttribute("aria-disabled");
  });
});
