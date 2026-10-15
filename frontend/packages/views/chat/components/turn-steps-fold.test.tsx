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
const running = { status: "in_progress" as const, completed_at: null };

function renderLive(turn: TraceTurn, items: TraceItem[]) {
  const ui = (nextTurn: TraceTurn, nextItems: TraceItem[]) => <LiveTurnSteps trace={{ turn: nextTurn, items: nextItems }} sessionId="chat_1" />;
  const view = renderWithI18n(ui(turn, items), { locale: "zh-Hans" });
  return { ...view, update: (nextTurn: TraceTurn, nextItems: TraceItem[]) => view.rerender(ui(nextTurn, nextItems)) };
}

describe("live fold header", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(T0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads 处理中 under a second, then ticks 已处理 each second, expanded", () => {
    renderLive(traceTurn(), []);
    expect(header()).toHaveTextContent("处理中");
    expect(isOpen()).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(header()).toHaveTextContent("处理中");
    act(() => { vi.advanceTimersByTime(1); });
    expect(header()).toHaveTextContent("已处理 1s");
    act(() => { vi.advanceTimersByTime(4000); });
    expect(header()).toHaveTextContent("已处理 5s");
    // Nothing is running yet: the trailing line says the agent is thinking.
    expect(document.querySelector("[data-step-live-line]")).toHaveTextContent("正在思考");
  });

  it("switches to 用时 and folds away when the first final item starts, before the turn ends", () => {
    const view = renderLive(traceTurn(), [command("cmd_1", [read("a.ts")])]);
    act(() => { vi.advanceTimersByTime(9000); });
    expect(header()).toHaveTextContent("已处理 9s");
    view.update(traceTurn(), [command("cmd_1", [read("a.ts")]), message("msg:f", "答案", "final", { ...running, started_at: at(7) })]);
    expect(header()).toHaveTextContent("用时 7s");
    expect(isOpen()).toBe(false);
    expect(document.querySelector("[data-chat-live-final]")).toHaveTextContent("答案");
    act(() => { vi.advanceTimersByTime(5000); });
    expect(header()).toHaveTextContent("用时 7s");
  });

  it("keeps the reader's own choice once they toggle the fold", () => {
    const view = renderLive(traceTurn(), [command("cmd_1", [read("a.ts")])]);
    fireEvent.click(header());
    expect(isOpen()).toBe(false);
    fireEvent.click(header());
    view.update(traceTurn(), [command("cmd_1", [read("a.ts")]), message("msg:f", "答案", "final", { started_at: at(2) })]);
    expect(isOpen()).toBe(true);
  });

  it("shows only the reply when a final starts with nothing before it, and stops after a cancel", () => {
    const view = renderLive(traceTurn(), [message("msg:f", "你好", "final", { started_at: at(1) })]);
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

  it("adds 「· N 个后台子代理运行中」 to the header without forcing the fold open", () => {
    const view = renderLive(traceTurn(), [background("sa:1", "Explore"), message("msg:1", "Started it.")]);
    expect(header()).toHaveTextContent("已处理 30s · 1 个后台子代理运行中");
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
      onOpenChange={setOpen} footer={<span data-testid="log">log</span>} />;
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
    expect(screen.getByTestId("log")).toBeInTheDocument();
  });

  it("shows the steps the live stream left in the cache even when that read found no trace yet", () => {
    client.setQueryData(["task-trace", "att_1"], { ...turnTraceCache(turnPage(traceTurn({ status: "completed" }), [command("cmd_1", [read("a.ts")])])),
      read: { state: "not_found", format: "v2" } });
    renderWithI18n(<Query><Fold initialOpen /></Query>, { locale: "zh-Hans" });
    expect(screen.getByText("已读取 a.ts")).toBeInTheDocument();
    expect(screen.queryByText("暂无执行过程记录")).toBeNull();
    expect(getTaskTrace).not.toHaveBeenCalled();
  });

  it("offers a retry when the read fails", async () => {
    getTaskTrace.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(turnPage(traceTurn({ status: "completed" }), [command("cmd_1", [read("a.ts")])]));
    renderWithI18n(<Query><Fold initialOpen /></Query>, { locale: "zh-Hans" });
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("已读取 a.ts")).toBeInTheDocument();
  });
});
