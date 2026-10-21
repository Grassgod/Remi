import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { TraceItem, TraceTurn } from "@multiremi/contracts/trace";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
import { renderWithI18n } from "../../test/i18n";
import {
  T0, at, command, compaction, message, read, reasoning, subagent, traceTurn, turnPage, turnTraceCache, unknown,
} from "../../test/trace-fixtures";
import { chatKeys } from "@multiremi/core/chat/queries";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { BG_SESSION, bgItem, bgSnapshot, bgTask } from "../lib/__fixtures__/background-tasks";
import { FinishedTurnSteps, LiveTurnSteps } from "./turn-steps-fold";

const { getTaskTrace } = vi.hoisted(() => ({ getTaskTrace: vi.fn() }));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: () => {} }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

// Subagent rows and the completion row open the panel through the chat store.
const storeValues = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => storeValues.get(key) ?? null,
  setItem: (key, value) => { storeValues.set(key, value); },
  removeItem: (key) => { storeValues.delete(key); },
} }));

const header = () => document.querySelector<HTMLButtonElement>("[data-chat-steps-header]")!;
const isOpen = () => header().hasAttribute("data-panel-open");
/** The working phase: the steps show inline, with no header text and no hairline. */
const expectInline = () => {
  expect(document.querySelector("[data-chat-steps-header]")).toBeNull();
  expect(document.querySelector('[data-slot="chain-of-thought-row"]')).toBeNull();
  expect(document.querySelector('[data-chat-steps="live"]')).toHaveAttribute("data-open");
};
const running = { status: "in_progress" as const, completed_at: null };

function renderLive(turn: TraceTurn, items: TraceItem[]) {
  const ui = (nextTurn: TraceTurn, nextItems: TraceItem[]) => <LiveTurnSteps trace={{ turn: nextTurn, items: nextItems }} sessionId="chat_1" />;
  const view = renderWithI18n(ui(turn, items), { locale: "zh-Hans" });
  return { ...view, update: (nextTurn: TraceTurn, nextItems: TraceItem[]) => view.rerender(ui(nextTurn, nextItems)) };
}

describe("live fold header", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(T0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows only the live line while the agent works, with no header, hairline or clock", () => {
    renderLive(traceTurn(), []);
    expectInline();
    // Nothing is running yet: the line says the agent is thinking.
    expect(document.querySelector("[data-step-live-line]")).toHaveTextContent("正在思考");
    act(() => { vi.advanceTimersByTime(5000); });
    expectInline();
    expect(screen.queryByText(/处理中|已处理/)).toBeNull();
  });

  it("shows the step rows inline while the agent works, then folds them under 用时 when the first final item starts", () => {
    const view = renderLive(traceTurn(), [command("cmd_1", [read("a.ts")])]);
    act(() => { vi.advanceTimersByTime(9000); });
    expectInline();
    expect(document.querySelector('[data-step-row="cmd_1:0"]')).toHaveTextContent("已读取 a.ts");
    expect(document.querySelector("[data-step-live-line]")).toHaveTextContent("正在思考");
    view.update(traceTurn(), [command("cmd_1", [read("a.ts")]), message("msg:f", "答案", "final", { ...running, started_at: at(7) })]);
    expect(header()).toHaveTextContent("用时 7s");
    expect(document.querySelector('[data-chat-steps="live"] [data-slot="chain-of-thought-row"]')).not.toBeNull();
    expect(isOpen()).toBe(false);
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
    expect(document.querySelector("[data-chat-live-final]")).toHaveTextContent("答案");
    act(() => { vi.advanceTimersByTime(5000); });
    expect(header()).toHaveTextContent("用时 7s");
  });

  it("keeps the reader's own choice once they toggle the fold", () => {
    const steps = [command("cmd_1", [read("a.ts")])];
    const view = renderLive(traceTurn(), [...steps, message("msg:f", "答", "final", { ...running, started_at: at(2) })]);
    expect(isOpen()).toBe(false);
    fireEvent.click(header());
    expect(isOpen()).toBe(true);
    view.update(traceTurn(), [...steps, message("msg:f", "答案", "final", { ...running, started_at: at(2) })]);
    expect(isOpen()).toBe(true);
    fireEvent.click(header());
    view.update(traceTurn(), [...steps, message("msg:f", "答案。", "final", { started_at: at(2) })]);
    expect(isOpen()).toBe(false);
  });

  it("shows only the reply when a final starts with nothing before it, and stops after a cancel", () => {
    // Thinking draws no step: a turn without process items has no fold once the reply starts.
    const view = renderLive(traceTurn(), [reasoning("rsn:1", "**Planning**"), message("msg:f", "你好", "final", { started_at: at(1) })]);
    expect(document.querySelector("[data-chat-steps]")).toBeNull();
    expect(document.querySelector("[data-chat-live-final]")).toHaveTextContent("你好");
    view.update(traceTurn({ status: "cancelled", duration_ms: 3000 }), [command("cmd_1", [read("a.ts")])]);
    expect(header()).toHaveTextContent("3s 后已停止");
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
  });

  it("renders nothing for a legacy trace", () => {
    const view = renderWithI18n(<LiveTurnSteps trace={{ turn: null, items: [] }} />);
    expect(view.container.innerHTML).toBe("");
  });
});

describe("live label", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(T0)); });
  afterEach(() => { vi.useRealTimers(); });
  const groupHeader = () => document.querySelector('[data-step-group] [data-slot="collapsible-trigger"]');

  it("holds each activity at least 1000ms, also on its finished group, then shows the summary", () => {
    const a = command("cmd_a", [read("a.ts")], running);
    const view = renderLive(traceTurn(), [a]);
    expect(document.querySelector("[data-step-live]")).toHaveTextContent("正在读取 a.ts");
    act(() => { vi.advanceTimersByTime(200); });
    // A finished and B started: the group header keeps A's label for its second.
    const b = command("cmd_b", [unknown("bun test")], running);
    view.update(traceTurn(), [{ ...a, status: "completed", completed_at: at(0.2) }, b]);
    expect(groupHeader()).toHaveTextContent("正在读取 a.ts");
    act(() => { vi.advanceTimersByTime(799); });
    expect(groupHeader()).toHaveTextContent("正在读取 a.ts");
    act(() => { vi.advanceTimersByTime(1); });
    expect(groupHeader()).toHaveTextContent("正在运行命令");
    // Both done: B's label holds on the finished group, with no thinking line yet.
    act(() => { vi.advanceTimersByTime(300); });
    view.update(traceTurn(), [{ ...a, status: "completed" }, { ...b, status: "completed", completed_at: at(1.5) }]);
    expect(groupHeader()).toHaveTextContent("正在运行命令");
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
    act(() => { vi.advanceTimersByTime(700); });
    expect(groupHeader()).toHaveTextContent("已读取文件，运行了命令");
    expect(document.querySelector("[data-step-live-line]")).toHaveTextContent("正在思考");
  });

  it("does not flash thinking in the idle gap between two fast steps", () => {
    const a = command("cmd_a", [read("a.ts")], running);
    const view = renderLive(traceTurn(), [a]);
    act(() => { vi.advanceTimersByTime(300); });
    // A done, nothing running yet: A's row keeps its label instead of "thinking".
    const aDone = { ...a, status: "completed" as const, completed_at: at(0.3) };
    view.update(traceTurn(), [aDone]);
    expect(document.querySelector('[data-step-row="cmd_a:0"] [data-step-live]')).toHaveTextContent("正在读取 a.ts");
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
    act(() => { vi.advanceTimersByTime(300); });
    // B starts inside A's second: still A's label, now on the group.
    view.update(traceTurn(), [aDone, command("cmd_b", [unknown("bun test")], running)]);
    expect(groupHeader()).toHaveTextContent("正在读取 a.ts");
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    expect(groupHeader()).toHaveTextContent("正在运行命令");
  });

  it("switches from thinking to an activity at once", () => {
    const view = renderLive(traceTurn(), []);
    expect(document.querySelector("[data-step-live-line]")).toHaveTextContent("正在思考");
    act(() => { vi.advanceTimersByTime(100); });
    view.update(traceTurn(), [command("cmd_a", [read("a.ts")], running)]);
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
    expect(document.querySelector("[data-step-live]")).toHaveTextContent("正在读取 a.ts");
  });

  it("adds no thinking line under a breaker that is still in progress", () => {
    const view = renderLive(traceTurn(), [command("cmd_a", [read("a.ts")])]);
    act(() => { vi.advanceTimersByTime(1500); });
    for (const breaker of [
      message("msg:1", "Looking at the tests", "unknown", running),
      subagent("sub_1", "Explore", running),
      compaction("cmp:1", running),
    ]) {
      view.update(traceTurn(), [command("cmd_a", [read("a.ts")]), breaker]);
      expect(document.querySelector("[data-step-live-line]")).toBeNull();
      expect(screen.queryByText("正在思考")).toBeNull();
    }
    view.update(traceTurn(), [command("cmd_a", [read("a.ts")]), message("msg:1", "Looking at the tests")]);
    expect(document.querySelector("[data-step-live-line]")).toHaveTextContent("正在思考");
  });

  it("reads the last reasoning line in place of thinking and holds it too", () => {
    const view = renderLive(traceTurn(), [reasoning("rsn:1", "**Checking the loader**", running)]);
    const line = () => document.querySelector("[data-step-live-line]");
    expect(line()).toHaveTextContent("Checking the loader");
    view.update(traceTurn(), [reasoning("rsn:1", "**Checking the loader**\n\n**Planning the fix**", running)]);
    expect(line()).toHaveTextContent("Checking the loader");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(line()).toHaveTextContent("Planning the fix");
    // No standalone "thought" rows: reasoning draws nothing of its own.
    expect(document.querySelectorAll("[data-step-row], [data-step-breaker]")).toHaveLength(0);
  });

  it("uses a static icon and the cadenced shimmer, never a spinner", () => {
    renderLive(traceTurn(), [command("cmd_a", [unknown("make")], running)]);
    const label = document.querySelector("[data-step-live]")!;
    expect(label.className).toContain("animate-step-shimmer");
    expect(document.querySelector(".animate-spin")).toBeNull();
    expect(label.closest("[data-step-row]")!.querySelector("svg.lucide-square-terminal")).not.toBeNull();
  });
});

describe("background subagents (PR 5 §6.3-6.4)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(at(30))); useChatStore.getState().closeSubagentPanel(); });
  afterEach(() => { vi.useRealTimers(); });
  const background = (id: string, name: string, overrides = {}) =>
    subagent(id, name, { name, background: true, ...running, started_at: at(2), ...overrides });

  it("adds 「· N 个后台子代理运行中」 to the 用时 header once the reply starts, without forcing the fold open", () => {
    const view = renderLive(traceTurn(), [background("sa:1", "Explore"), message("msg:1", "Started it.")]);
    // Before the reply there is no header to carry it (the running strip names the subagent); its row shows inline.
    expectInline();
    expect(document.querySelector("[data-fold-background-running]")).toBeNull();
    expect(document.querySelector('[data-subagent-row="sa:1"]')).not.toBeNull();
    // The caller only waits: no thinking line under the steps.
    expect(document.querySelector("[data-step-live-line]")).toBeNull();
    // After the reply starts the fold folds away and the suffix stays.
    view.update(traceTurn(), [background("sa:1", "Explore"), message("msg:f", "Answer", "final", { started_at: at(20) })]);
    expect(isOpen()).toBe(false);
    expect(header()).toHaveTextContent("用时 20s · 1 个后台子代理运行中");
    // Any top-level subagent still running once the reply started counts.
    view.update(traceTurn(), [background("sa:1", "Explore"), subagent("sa:2", "Plan", { ...running, background: false }),
      message("msg:f", "Answer", "final", { started_at: at(20) })]);
    expect(header()).toHaveTextContent("· 2 个后台子代理运行中");
    view.update(traceTurn(), [background("sa:1", "Explore", { status: "completed", completed_at: at(25), duration_ms: 23_000 }),
      message("msg:f", "Answer", "final", { started_at: at(20) })]);
    expect(document.querySelector("[data-fold-background-running]")).toBeNull();
  });

  it("puts a completion row under the reply for a subagent that ended after it started, opening its detail", () => {
    renderLive(traceTurn(), [
      background("sa:1", "Explore", { status: "completed", completed_at: at(26), duration_ms: 24_000 }),
      background("sa:2", "Plan", { status: "failed", completed_at: at(27) }),
      subagent("sa:3", "Early", { name: "Early", completed_at: at(5) }),
      message("msg:f", "Answer", "final", { started_at: at(20) }),
    ]);
    const rows = [...document.querySelectorAll<HTMLButtonElement>("[data-subagent-late-row]")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Explore 已在后台完成 · 24s · 查看结果",
      "Plan 在后台失败 · 查看详情",
    ]);
    // Under the reply, never before it.
    const reply = document.querySelector("[data-chat-live-final]")!;
    expect(reply.compareDocumentPosition(rows[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(rows[0]!);
    expect(useChatStore.getState().subagentPanel).toEqual({ sessionId: "chat_1", attemptId: "att_1", turnId: "turn_1", live: true, path: ["sa:1"] });
  });

  it("folds more than three late subagents into one uncounted line that opens the overview", () => {
    const late = (count: number) => [
      ...Array.from({ length: count }, (_, index) => background(`sa:${index}`, `Agent ${index}`, { status: "completed", completed_at: at(21 + index) })),
      message("msg:f", "Answer", "final", { started_at: at(20) }),
    ];
    const view = renderLive(traceTurn(), late(7));
    expect(document.querySelectorAll("[data-subagent-late-row]")).toHaveLength(3);
    const more = document.querySelector<HTMLButtonElement>("[data-subagent-late-more]")!;
    // No count: a stored card keeps at most five, so a number would drift.
    expect(more).toHaveTextContent(/^另有更多子代理在后台结束$/);
    fireEvent.click(more);
    expect(useChatStore.getState().subagentPanel?.path).toEqual([]);
    view.update(traceTurn(), late(4));
    expect(document.querySelector("[data-subagent-late-more]")).toHaveTextContent(/^另有更多子代理在后台结束$/);
    view.update(traceTurn(), late(3));
    expect(document.querySelectorAll("[data-subagent-late-row]")).toHaveLength(3);
    expect(document.querySelector("[data-subagent-late-more]")).toBeNull();
  });

  it("opens the fold and its row when the running strip reveals a subagent", () => {
    const view = renderLive(traceTurn(), [background("sa:1", "Explore"), message("msg:f", "Answer", "final", { started_at: at(20) })]);
    expect(isOpen()).toBe(false);
    act(() => { useChatStore.getState().revealSubagent("att_other", "sa:1"); });
    expect(isOpen()).toBe(false);
    act(() => { useChatStore.getState().revealSubagent("att_1", "sa:1"); });
    expect(isOpen()).toBe(true);
    view.unmount();
  });

  it("scrolls to the inline row when the strip reveals a subagent before the reply, leaving the fold to close when it starts", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 20, width: 100 } as DOMRect);
    try {
      const view = renderLive(traceTurn(), [background("sa:1", "Explore"), message("msg:1", "Started it.")]);
      act(() => { useChatStore.getState().revealSubagent("att_1", "sa:1"); });
      act(() => { vi.advanceTimersByTime(400); });
      expectInline();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-chat-live-turn=""] [data-subagent-row="sa:1"]'));
      // The reveal opened nothing, so the steps still fold away under the header.
      view.update(traceTurn(), [background("sa:1", "Explore"), message("msg:f", "Answer", "final", { started_at: at(20) })]);
      expect(isOpen()).toBe(false);
      view.unmount();
    } finally {
      vi.restoreAllMocks();
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("does not replay an old reveal when the fold mounts again", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 20, width: 100 } as DOMRect);
    try {
      const items = [background("sa:1", "Explore"), message("msg:f", "Answer", "final", { started_at: at(20) })];
      const first = renderLive(traceTurn(), items);
      act(() => { useChatStore.getState().revealSubagent("att_1", "sa:1"); });
      act(() => { vi.advanceTimersByTime(400); });
      expect(isOpen()).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      // Switching to another chat and back (or page ↔ floating) remounts the fold.
      first.unmount();
      expect(useChatStore.getState().subagentReveal).not.toBeNull();
      const second = renderLive(traceTurn(), items);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(isOpen()).toBe(false);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      // A new request still works.
      act(() => { useChatStore.getState().revealSubagent("att_1", "sa:1"); });
      act(() => { vi.advanceTimersByTime(400); });
      expect(isOpen()).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      second.unmount();
    } finally {
      vi.restoreAllMocks();
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("finished fold (MUL-472)", () => {
  let client: QueryClient;
  const Query = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); getTaskTrace.mockReset(); });

  function Fold({ initialOpen = false }: { initialOpen?: boolean }) {
    const [open, setOpen] = useState(initialOpen);
    return <FinishedTurnSteps attemptId="att_1" turnId="turn_1" header={{ kind: "worked_for", ms: 65_000 }} visible open={open}
      onOpenChange={setOpen} />;
  }

  it("reads the trace only once the reader opens it, and leaves the final reply out", async () => {
    getTaskTrace.mockResolvedValue(turnPage(traceTurn({ status: "completed" }), [
      command("cmd_1", [read("a.ts")]), command("cmd_2", [unknown("bun test")]), message("msg:f", "Final reply", "final"),
    ]));
    renderWithI18n(<Query><Fold /></Query>, { locale: "zh-Hans" });
    expect(header()).toHaveTextContent("用时 1m 5s");
    expect(isOpen()).toBe(false);
    expect(getTaskTrace).not.toHaveBeenCalled();
    fireEvent.click(header());
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("att_1", { itemCursor: 0, turnId: "turn_1" }));
    expect(await screen.findByText("已读取文件，运行了命令")).toBeInTheDocument();
    expect(screen.queryByText("Final reply")).toBeNull();
    // The execution-log button lives in the reply's footer row, not in the fold.
    expect(screen.queryByText("查看执行记录")).toBeNull();
  });

  it("shows the steps the live stream left in the cache even when that read found no trace yet, then reads again", async () => {
    const page = turnPage(traceTurn({ status: "completed" }), [command("cmd_1", [read("a.ts")])]);
    client.setQueryData(["task-trace", "att_1"], { ...turnTraceCache(page), read: { state: "not_found", format: "v2" } });
    getTaskTrace.mockResolvedValue(page);
    renderWithI18n(<Query><Fold initialOpen /></Query>, { locale: "zh-Hans" });
    expect(screen.getByText("已读取 a.ts")).toBeInTheDocument();
    expect(screen.queryByText("暂无执行过程记录")).toBeNull();
    // A read that was not ok is never kept: the fold reads the sealed trace once more.
    await waitFor(() => expect(client.getQueryData<{ read: { state: string } }>(["task-trace", "att_1"])?.read.state).toBe("ok"));
    expect(getTaskTrace).toHaveBeenCalledTimes(1);
    expect(screen.getByText("已读取 a.ts")).toBeInTheDocument();
  });

  it("offers a retry when the read fails", async () => {
    getTaskTrace.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(turnPage(traceTurn({ status: "completed" }), [command("cmd_1", [read("a.ts")])]));
    renderWithI18n(<Query><Fold initialOpen /></Query>, { locale: "zh-Hans" });
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("已读取 a.ts")).toBeInTheDocument();
  });
});

describe("background launch rows (PR 6 §8.1 Steps)", () => {
  let client: QueryClient;
  const Query = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const launch = command("cmd:dev", [unknown("npm run dev")], { title: "启动开发服务器" });
  const handedOff = bgItem("dev", "cmd:dev", { status: "completed", completed_at: at(9), handed_off: true });
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getTaskTrace.mockReset();
    setCurrentWorkspace("demo", "ws-1");
  });

  function Fold() {
    const [open, setOpen] = useState(true);
    return <FinishedTurnSteps attemptId="att_1" turnId="turn_1" sessionId={BG_SESSION} header={{ kind: "worked_for", ms: 9_000 }} visible open={open} onOpenChange={setOpen} />;
  }

  it("reads the finished turn's launch row from the registry when it is loaded, else neutrally from its trace item", async () => {
    client.setQueryData(["task-trace", "att_1"], turnTraceCache(turnPage(traceTurn({ status: "completed" }), [launch, handedOff])));
    renderWithI18n(<Query><Fold /></Query>, { locale: "zh-Hans" });
    // Nothing loaded: the trace item only knows the task was handed off, never that it still runs (review #6).
    expect(screen.getByText("启动开发服务器 已转到后台运行")).toBeInTheDocument();
    expect(screen.queryByText(/仍在后台运行/)).toBeNull();
    // The registry confirms it runs.
    act(() => { client.setQueryData(chatKeys.backgroundTasks("ws-1", BG_SESSION), bgSnapshot([bgTask("dev")])); });
    await waitFor(() => expect(screen.getByText("启动开发服务器 仍在后台运行")).toBeInTheDocument());
    // It was stopped at the keep-alive cap later.
    act(() => { client.setQueryData(chatKeys.backgroundTasks("ws-1", BG_SESSION), bgSnapshot([bgTask("dev", { status: "stopped", stop_reason: "keepalive_cap" })])); });
    await waitFor(() => expect(screen.getByText("后台命令已停止 启动开发服务器")).toBeInTheDocument());
    expect(document.querySelector('[data-step-row="cmd:dev:0"]')).toHaveAttribute("data-step-state", "stopped");
    // The task item itself draws no row; nothing was read for it.
    expect(document.querySelectorAll("[data-step-row], [data-step-breaker]")).toHaveLength(1);
    expect(getTaskTrace).not.toHaveBeenCalled();
  });

  it("says a hand-off moved to the background the next day, when the chat counts no running task", () => {
    // A chat whose count is 0 never reads its registry; a day-old row aged out anyway.
    client.setQueryData(["task-trace", "att_1"], turnTraceCache(turnPage(traceTurn({ status: "completed" }), [launch, handedOff])));
    client.setQueryData(chatKeys.backgroundTasks("ws-1", BG_SESSION), bgSnapshot([bgTask("other", { status: "completed", ended_at: at(30) })]));
    renderWithI18n(<Query><Fold /></Query>, { locale: "en" });
    expect(screen.getByText("启动开发服务器 moved to the background")).toBeInTheDocument();
    expect(screen.queryByText(/still running/)).toBeNull();
    expect(getTaskTrace).not.toHaveBeenCalled();
  });

  it("reads a running launch row as started while its attempt runs", () => {
    renderWithI18n(<Query><LiveTurnSteps trace={{ turn: traceTurn(), items: [launch, bgItem("dev", "cmd:dev")] }} sessionId={BG_SESSION} /></Query>, { locale: "zh-Hans" });
    expect(screen.getByText("已启动后台命令 启动开发服务器")).toBeInTheDocument();
  });
});
