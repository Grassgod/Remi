import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TraceItem } from "@multiremi/contracts/trace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
import { chatKeys } from "@multiremi/core/chat/queries";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { renderWithI18n } from "../../test/i18n";
import { subagent } from "../../test/trace-fixtures";
import { bgSnapshot, bgTask } from "../lib/__fixtures__/background-tasks";
import { chatLogWithSubagents, turnCard, histogram } from "../lib/__fixtures__/side-panel";
import { EMPTY_PANEL_RECORD, chatSubagentTurns, type ChatPanelRecord } from "../lib/side-panel-record";
import { ChatSidePanelToggle, useChatPanelRecord } from "./side-panel-toggle";

const { getTaskTrace } = vi.hoisted(() => ({ getTaskTrace: vi.fn() }));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: () => {} }));

const values = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
} }));

let client: QueryClient;

function renderToggle(props: { record: ChatPanelRecord; running?: number; sessionId?: string | null; presentation?: "page" | "window" }) {
  const ui = (next: typeof props) => (
    <QueryClientProvider client={client}>
      <ChatSidePanelToggle sessionId={next.sessionId === undefined ? "chat_1" : next.sessionId} record={next.record}
        running={next.running ?? 0} presentation={next.presentation ?? "page"} />
    </QueryClientProvider>
  );
  const view = renderWithI18n(ui(props), { locale: "zh-Hans" });
  return { ...view, update: (next: typeof props) => view.rerender(ui(next)) };
}

const toggle = () => screen.queryByRole("button", { name: /^查看子代理与后台任务/ });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setCurrentWorkspace("demo", "ws-1");
  act(() => { useChatStore.getState().closeSubagentPanel(); });
  getTaskTrace.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("header side panel toggle", () => {
  it("shows only for a chat with a subagent or background task on record, and never reads a trace itself", () => {
    const view = renderToggle({ record: EMPTY_PANEL_RECORD });
    expect(toggle()).toBeNull();
    view.update({ record: { turns: chatSubagentTurns(chatLogWithSubagents()), tasks: false } });
    expect(toggle()).not.toBeNull();
    view.update({ record: { turns: [], tasks: true } });
    expect(toggle()).not.toBeNull();
    // No chat yet (a new chat): nothing to open.
    view.update({ record: { turns: [], tasks: true }, sessionId: null });
    expect(toggle()).toBeNull();
    expect(getTaskTrace).not.toHaveBeenCalled();
  });

  it("badges what runs now and says so in its name, with no badge at 0", () => {
    const record = { turns: chatSubagentTurns(chatLogWithSubagents()), tasks: true };
    const view = renderToggle({ record, running: 3 });
    expect(toggle()).toHaveAccessibleName("查看子代理与后台任务（3 个运行中）");
    expect(toggle()!.querySelector("[data-side-panel-badge]")).toHaveTextContent("3");
    view.update({ record, running: 0 });
    expect(toggle()).toHaveAccessibleName("查看子代理与后台任务");
    expect(toggle()!.querySelector("[data-side-panel-badge]")).toBeNull();
    view.update({ record, running: 120 });
    expect(toggle()!.querySelector("[data-side-panel-badge]")).toHaveTextContent("99+");
  });

  it("opens the chat-wide 子代理 overview on the newest subagent turn, and closes it again", () => {
    const record = { turns: chatSubagentTurns(chatLogWithSubagents()), tasks: true };
    renderToggle({ record });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).not.toHaveAttribute("aria-controls");
    fireEvent.click(toggle()!);
    expect(useChatStore.getState().subagentPanel).toEqual({
      sessionId: "chat_1", view: "subagents", attemptId: "att_3", turnId: "turn_3", live: false, path: [],
    });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveAttribute("aria-controls", "chat-side-panel-page");
    fireEvent.click(toggle()!);
    expect(useChatStore.getState().subagentPanel).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the 后台任务 view when the chat only has tasks, and closes a panel opened elsewhere", () => {
    renderToggle({ record: { turns: [], tasks: true }, presentation: "window" });
    fireEvent.click(toggle()!);
    expect(useChatStore.getState().subagentPanel).toEqual({ sessionId: "chat_1", view: "tasks", attemptId: null, live: false, path: [], task: null });
    expect(toggle()).toHaveAttribute("aria-controls", "chat-side-panel-window");
    // A step row opened a detail: the toggle reads as open and closes it.
    act(() => { useChatStore.getState().openSubagentPanel({ sessionId: "chat_1", attemptId: "att_1", live: false, path: ["sa:1"] }); });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle()!);
    expect(useChatStore.getState().subagentPanel).toBeNull();
    // Another chat's panel is not this one's.
    act(() => { useChatStore.getState().openSubagentPanel({ sessionId: "chat_2", attemptId: "att_9", live: false, path: [] }); });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("useChatPanelRecord", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  it("joins the log's turns, the live trace and the background-task counts, without reading anything", () => {
    const running = { status: "in_progress" as const, completed_at: null };
    const entries = [...chatLogWithSubagents(), turnCard("att_5", "turn_5", { status: "running" }, 300)];
    const { result, rerender } = renderHook((props: { items: TraceItem[]; tasks: number }) => useChatPanelRecord({
      sessionId: "chat_1", entries, live: { attemptId: "att_5", turnId: "turn_5", items: props.items }, backgroundTasksRunning: props.tasks,
    }), { wrapper, initialProps: { items: [] as TraceItem[], tasks: 0 } });
    expect(result.current.record.turns.map((turn) => turn.attemptId)).toEqual(["att_3", "att_1"]);
    // The window shows a card that started a background task.
    expect(result.current.record.tasks).toBe(true);
    expect(result.current.running).toBe(0);
    rerender({ items: [subagent("sa:1", "A", running), subagent("sa:2", "B", running), subagent("sa:3", "C")], tasks: 2 });
    expect(result.current.record.turns[0]).toMatchObject({ attemptId: "att_5", live: true });
    expect(result.current.running).toBe(4);
    expect(getTaskTrace).not.toHaveBeenCalled();
  });

  it("counts registry rows and the session's running count as tasks on record", () => {
    const entries = [turnCard("att_1", "turn_1", { type_histogram: histogram("command") })];
    const { result } = renderHook((props: { tasks: number }) => useChatPanelRecord({
      sessionId: "chat_1", entries, live: null, backgroundTasksRunning: props.tasks,
    }), { wrapper, initialProps: { tasks: 0 } });
    expect(result.current.record).toEqual({ turns: [], tasks: false });
    act(() => { client.setQueryData(chatKeys.backgroundTasks("ws-1", "chat_1"), bgSnapshot([bgTask("done", { status: "completed" })], "chat_1")); });
    expect(result.current.record.tasks).toBe(true);
  });
});
