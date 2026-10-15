import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { TraceItem } from "@multiremi/contracts/trace";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
import { renderWithI18n } from "../../test/i18n";
import { at } from "../../test/trace-fixtures";
import { claudeDoneItems, claudeLiveItems } from "../lib/__fixtures__/subagents";
import { SubagentRunningStrip } from "./subagent-running-strip";

const values = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
} }));

const SOURCE = { sessionId: "chat_1", attemptId: "att_1", turnId: "turn_1", live: true };

function renderStrip(items: TraceItem[], locale: "zh-Hans" | "en" = "zh-Hans") {
  const ui = (next: TraceItem[]) => <SubagentRunningStrip items={next} source={SOURCE} />;
  const view = renderWithI18n(ui(items), { locale });
  return { ...view, update: (next: TraceItem[]) => view.rerender(ui(next)) };
}
const strip = () => document.querySelector<HTMLElement>("[data-subagent-strip]");

describe("running strip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(at(20)));
    useChatStore.getState().closeSubagentPanel();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("counts top-level running subagents and shows each as a chip with its time and the background tag", () => {
    renderStrip(claudeLiveItems());
    expect(document.querySelector("[data-strip-overview]")).toHaveTextContent("2 个子代理运行中");
    const chips = [...document.querySelectorAll<HTMLElement>("[data-strip-chip]")];
    expect(chips.map((chip) => chip.getAttribute("data-strip-chip"))).toEqual(["sa:explore", "sa:plan"]);
    expect(chips[0]).toHaveTextContent("查找 trace 读取方· 18s后台");
    expect(chips[1]).toHaveTextContent("设计面板数据流· 10s");
    expect(chips[1]).not.toHaveTextContent("后台");
    // The nested agent goes into the +N button.
    expect(document.querySelector("[data-strip-more]")).toHaveTextContent("+1");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(chips[1]).toHaveTextContent("· 11s");
    // No stop button: child sessions cannot be steered.
    expect(within(strip()!).queryByRole("button", { name: /停止|Stop/ })).toBeNull();
  });

  it("is gone when no subagent runs, and counts nested ones when no top-level one runs", () => {
    const view = renderStrip(claudeDoneItems());
    expect(strip()).toBeNull();
    const items = claudeLiveItems().map((item) => item.type === "subagent" && item.parent_id === null
      ? { ...item, status: "completed" as const, completed_at: at(19) } : item);
    view.update(items);
    expect(document.querySelector("[data-strip-overview]")).toHaveTextContent("1 个子代理运行中");
    expect(document.querySelectorAll("[data-strip-chip]")).toHaveLength(0);
  });

  it("opens the overview from the count and a chip's detail, revealing its row", () => {
    renderStrip(claudeLiveItems());
    fireEvent.click(document.querySelector("[data-strip-overview]")!);
    expect(useChatStore.getState().subagentPanel).toEqual({ ...SOURCE, path: [] });
    fireEvent.click(document.querySelector('[data-strip-chip="sa:plan"]')!);
    expect(useChatStore.getState().subagentPanel).toEqual({ ...SOURCE, path: ["sa:plan"] });
    expect(useChatStore.getState().subagentReveal).toMatchObject({ attemptId: "att_1", itemId: "sa:plan" });
    expect(document.querySelector('[data-strip-chip="sa:plan"]')!.className).toContain("bg-brand/10");
  });

  it("lists the running tree with each agent's live activity in the ▾ popover", async () => {
    renderStrip(claudeLiveItems());
    fireEvent.click(screen.getByRole("button", { name: "查看运行中的子代理" }));
    const tree = await screen.findByText("运行中的子代理");
    const popover = tree.closest<HTMLElement>("[data-strip-tree]")!;
    const rows = [...popover.querySelectorAll<HTMLElement>("[data-strip-tree-row]")];
    expect(rows.map((row) => [row.getAttribute("data-strip-tree-row"), row.style.paddingLeft])).toEqual([
      ["sa:explore", "8px"], ["sa:gp", "24px"], ["sa:plan", "8px"],
    ]);
    // Explore waits on its nested agent: it shows the nested one's work.
    expect(rows[0]!.querySelector("[data-strip-activity]")).toHaveTextContent("核对飞书步骤文案：正在读取 cot-timeline.ts");
    expect(rows[1]!.querySelector("[data-strip-activity]")).toHaveTextContent("正在读取 cot-timeline.ts");
    // Plan's report is streaming.
    expect(rows[2]!.querySelector("[data-strip-activity]")).toHaveTextContent("正在写报告");
    fireEvent.click(rows[1]!);
    expect(useChatStore.getState().subagentPanel?.path).toEqual(["sa:explore", "sa:gp"]);
    expect(useChatStore.getState().subagentReveal).toMatchObject({ itemId: "sa:explore" });
  });

  it("reads in English", () => {
    renderStrip(claudeLiveItems(), "en");
    expect(document.querySelector("[data-strip-overview]")).toHaveTextContent("2 subagents running");
    expect(screen.getByRole("button", { name: "Show running subagents" })).toBeInTheDocument();
  });
});
