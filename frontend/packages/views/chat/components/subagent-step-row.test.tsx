import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import type { TraceItem, TraceSubagentItem } from "@multiremi/contracts/trace";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
import { renderWithI18n } from "../../test/i18n";
import { T0, at, command, read, subagent } from "../../test/trace-fixtures";
import { claudeLiveItems } from "../lib/__fixtures__/subagents";
import { SubagentTraceContext } from "./subagent-context";
import { SubagentStepRow } from "./subagent-step-row";

const values = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
} }));

const running = { status: "in_progress" as const, completed_at: null, duration_ms: null };
const SOURCE = { sessionId: "chat_1", attemptId: "att_1", turnId: "turn_1", live: true };

function renderRow(item: TraceSubagentItem, items: TraceItem[] = [item], { source = SOURCE as typeof SOURCE | null, locale = "zh-Hans" as const } = {}) {
  const ui = (nextItem: TraceSubagentItem, nextItems: TraceItem[]) => source
    ? <SubagentTraceContext.Provider value={source}><SubagentStepRow item={nextItem} items={nextItems} /></SubagentTraceContext.Provider>
    : <SubagentStepRow item={nextItem} items={nextItems} />;
  const view = renderWithI18n(ui(item, items), { locale });
  return { ...view, update: (nextItem: TraceSubagentItem, nextItems: TraceItem[] = [nextItem]) => view.rerender(ui(nextItem, nextItems)) };
}
const row = () => document.querySelector<HTMLButtonElement>("[data-subagent-row]")!;
const status = () => document.querySelector<HTMLElement>("[data-subagent-status-text]")!;

describe("SubagentStepRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    useChatStore.getState().closeSubagentPanel();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("is one line, name · task, named for the panel it opens", () => {
    renderRow(subagent("sa:1", "查找 trace 读取方", { name: "查找 trace 读取方", agent_type: "Explore", prompt: "在 `frontend` 里找读取方\n第二行" }));
    expect(row()).toHaveTextContent("查找 trace 读取方 · 在 frontend 里找读取方");
    expect(row()).not.toHaveTextContent("Explore");
    expect(row()).toHaveAccessibleName("打开子代理 查找 trace 读取方");
    expect(row()).toBeEnabled();
  });

  it("ticks 运行中 / 后台运行中 once a second and shows no live activity", () => {
    const item = subagent("sa:1", "Explore", { ...running, name: "Explore", started_at: T0 });
    const child = command("cmd_1", [read("a.ts")], { parent_id: "sa:1", ...running });
    const view = renderRow(item, [item, child]);
    expect(status()).toHaveAttribute("data-subagent-status-text", "running");
    expect(status()).toHaveTextContent("运行中 0s");
    act(() => { vi.advanceTimersByTime(3000); });
    expect(status()).toHaveTextContent("运行中 3s");
    expect(row()).not.toHaveTextContent("正在读取");
    view.update({ ...item, background: true }, [{ ...item, background: true }, child]);
    expect(status()).toHaveTextContent("后台运行中 3s");
    expect(status().className).toContain("text-violet");
  });

  it("reads ✓ N 个工具 · duration (own level only), ✓ 已完成, ✕ 失败 and ■ 已停止", () => {
    const done = subagent("sa:1", "Explore", { name: "Explore", duration_ms: 41_000 });
    const nested = subagent("sa:2", "Nested", { parent_id: "sa:1" });
    const view = renderRow(done, [done, command("c1", [read("a.ts")], { parent_id: "sa:1" }), command("c2", [read("b.ts")], { parent_id: "sa:1" }),
      nested, command("c3", [read("c.ts")], { parent_id: "sa:2" })]);
    expect(status()).toHaveTextContent("2 个工具 · 41s");
    view.update(done);
    expect(status()).toHaveTextContent("已完成 · 41s");
    view.update({ ...done, status: "failed" });
    expect(status()).toHaveTextContent("失败");
    expect(status().className).toContain("text-destructive");
    view.update({ ...done, status: "stopped" });
    expect(status()).toHaveTextContent("已停止");
  });

  it("uses en plurals", () => {
    const done = subagent("sa:1", "Explore", { name: "Explore", duration_ms: 2000 });
    renderRow(done, [done, command("c1", [read("a.ts")], { parent_id: "sa:1" })], { locale: "en" as never });
    expect(status()).toHaveTextContent("1 tool · 2s");
    expect(row()).toHaveAccessibleName("Open subagent Explore");
  });

  it("opens the panel at the subagent's path and is highlighted while the panel shows it or a descendant", () => {
    const items = claudeLiveItems();
    const nested = items.find((item) => item.id === "sa:gp") as TraceSubagentItem;
    renderRow(nested, items);
    expect(row()).not.toHaveAttribute("data-highlighted");
    fireEvent.click(row());
    expect(useChatStore.getState().subagentPanel).toEqual({ ...SOURCE, path: ["sa:explore", "sa:gp"] });
    expect(row()).toHaveAttribute("data-highlighted", "true");
    act(() => { useChatStore.getState().setSubagentPath(["sa:explore"]); });
    expect(row()).not.toHaveAttribute("data-highlighted");
  });

  it("opens nothing outside a turn with an attempt", () => {
    renderRow(subagent("sa:1", "Explore", { started_at: at(0) }), undefined, { source: null });
    expect(row()).toBeDisabled();
    fireEvent.click(row());
    expect(useChatStore.getState().subagentPanel).toBeNull();
  });
});
