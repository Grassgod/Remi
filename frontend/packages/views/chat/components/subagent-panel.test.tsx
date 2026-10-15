import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TraceItem } from "@multiremi/contracts/trace";
import { createChatStore, registerChatStore, useChatStore, type SubagentPanelTarget } from "@multiremi/core/chat";
import { renderWithI18n } from "../../test/i18n";
import { T0, at, command, read, subagent, traceTurn, turnPage, turnTraceCache } from "../../test/trace-fixtures";
import { claudeDoneItems, claudeLiveItems, codexItems } from "../lib/__fixtures__/subagents";
import { SubagentPanelLayout } from "./subagent-panel";

const { getTaskTrace, mobile } = vi.hoisted(() => ({ getTaskTrace: vi.fn(), mobile: { value: false } }));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: () => {} }));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

const values = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
} }));

let client: QueryClient;

function seed(items: TraceItem[], status: "running" | "completed" = "running") {
  client.setQueryData(["task-trace", "att_1"], turnTraceCache(turnPage(traceTurn({ status }), items)));
}

function open(target: Partial<SubagentPanelTarget> = {}) {
  act(() => {
    useChatStore.getState().openSubagentPanel({ sessionId: "chat_1", attemptId: "att_1", turnId: "turn_1", live: true, path: [], ...target });
  });
}

function renderLayout({ sessionId = "chat_1", presentation = "page" as "page" | "window" } = {}) {
  const ui = (session: string, visible = true) => (
    <QueryClientProvider client={client}>
      <SubagentPanelLayout sessionId={session} presentation={presentation} visible={visible}>
        <div data-testid="chat-conversation">conversation</div>
      </SubagentPanelLayout>
    </QueryClientProvider>
  );
  const view = renderWithI18n(ui(sessionId), { locale: "zh-Hans" });
  return {
    ...view,
    switchTo: (next: string) => view.rerender(ui(next)),
    setVisible: (visible: boolean) => view.rerender(ui(sessionId, visible)),
  };
}

const panel = () => document.querySelector<HTMLElement>("[data-subagent-panel]");
const overviewRow = (id: string) => document.querySelector<HTMLButtonElement>(`[data-subagent-overview-row="${id}"]`)!;

describe("subagent panel", () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useChatStore.getState().closeSubagentPanel();
    getTaskTrace.mockReset();
    mobile.value = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(at(20)));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows nothing until a subagent entry point opens it, and keeps the conversation mounted", () => {
    seed(claudeLiveItems());
    renderLayout();
    const conversation = screen.getByTestId("chat-conversation");
    expect(panel()).toBeNull();
    open();
    expect(panel()).toHaveAttribute("data-subagent-panel", "overview");
    expect(screen.getByTestId("chat-conversation")).toBe(conversation);
    // Read-only: no composer, the note says where to steer.
    expect(document.querySelector("[data-subagent-panel-footer]")).toHaveTextContent("子代理只读。如需调整，请在主对话中说明。");
    expect(panel()!.querySelector("textarea, [contenteditable]")).toBeNull();
  });

  it("lists top-level subagents in 运行中 / 已完成 sections with show more and show less", () => {
    const agents = Array.from({ length: 6 }, (_, index) => subagent(`sa:r${index}`, `R${index}`,
      { name: `R${index}`, status: "in_progress", completed_at: null, duration_ms: null, started_at: at(index) }));
    const done = Array.from({ length: 12 }, (_, index) => subagent(`sa:d${index}`, `D${index}`, { name: `D${index}`, duration_ms: 1000 }));
    seed([...agents, ...done, subagent("sa:nested", "Nested", { parent_id: "sa:r0", status: "in_progress", completed_at: null })]);
    renderLayout();
    open();
    const running = document.querySelector<HTMLElement>('[data-subagent-section="running"]')!;
    const finished = document.querySelector<HTMLElement>('[data-subagent-section="done"]')!;
    expect(running.querySelector("h3")).toHaveTextContent("运行中 · 6");
    expect(finished.querySelector("h3")).toHaveTextContent("已完成 · 12");
    expect(running.querySelectorAll("[data-subagent-overview-row]")).toHaveLength(4);
    expect(finished.querySelectorAll("[data-subagent-overview-row]")).toHaveLength(10);
    // Nested subagents are reached through their parent's detail.
    expect(overviewRow("sa:nested")).toBeNull();
    fireEvent.click(within(running).getByRole("button", { name: "再显示 2 个" }));
    expect(running.querySelectorAll("[data-subagent-overview-row]")).toHaveLength(6);
    fireEvent.click(within(running).getByRole("button", { name: "收起" }));
    expect(running.querySelectorAll("[data-subagent-overview-row]")).toHaveLength(4);
  });

  it("gives each overview row its type, its time and its task, and an empty turn its own line", () => {
    seed(claudeLiveItems());
    renderLayout();
    open();
    const explore = overviewRow("sa:explore");
    expect(explore).toHaveTextContent("查找 trace 读取方 Explore");
    expect(explore).toHaveTextContent("后台18s");
    expect(explore).toHaveTextContent("在 frontend/packages 里找出所有读取 trace 的组件");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(overviewRow("sa:explore")).toHaveTextContent("20s");
    act(() => { useChatStore.getState().closeSubagentPanel(); });
    seed([]);
    open();
    expect(document.querySelector('[data-subagent-overview="empty"]')).toHaveTextContent("这一轮没有子代理");
  });

  it("opens a detail as a mini conversation: task bubble, steps fold and reply, and goes back", () => {
    seed(claudeDoneItems(), "completed");
    renderLayout();
    open({ live: false });
    fireEvent.click(overviewRow("sa:review"));
    expect(useChatStore.getState().subagentPanel?.path).toEqual(["sa:review"]);
    const detail = document.querySelector<HTMLElement>('[data-subagent-detail="sa:review"]')!;
    const header = document.querySelector<HTMLElement>("[data-subagent-panel-header]")!;
    expect(header).toHaveTextContent("审阅文案差异 · 审阅 claude/feishu-step-copy 分支的改动。");
    expect(header.querySelector("[data-subagent-type]")).toHaveTextContent("Explore");
    expect(header).toHaveTextContent("3 个工具 · 41s");
    // Two generations: the spawn task, then the resumed instruction.
    const bubbles = [...detail.querySelectorAll("[data-subagent-task]")];
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual(["任务审阅 `claude/feishu-step-copy` 分支的改动。", "再看看 ja 和 ko 的翻译"]);
    const replies = [...detail.querySelectorAll("[data-subagent-reply]")].map((reply) => reply.textContent);
    expect(replies).toEqual(["第一轮：中文文案没问题。", "审阅结论：ja / ko 缺两个片段。"]);
    // The steps fold leaves the reply out and is timed by the generation.
    const folds = [...detail.querySelectorAll<HTMLElement>("[data-subagent-steps]")];
    expect(folds.map((fold) => fold.querySelector("[data-chat-steps-header]")!.textContent)).toEqual(["用时 19s", "用时 22s"]);
    fireEvent.click(folds[0]!.querySelector("[data-chat-steps-header]")!);
    expect(within(folds[0]!).queryByText("第一轮：中文文案没问题。")).toBeNull();
    expect(detail.querySelector("[data-subagent-meta]")).toHaveTextContent("模型 haiku · 后台");
    fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }));
    expect(panel()).toHaveAttribute("data-subagent-panel", "overview");
  });

  it("opens a nested subagent one level deeper, and ← goes up one level", () => {
    seed(claudeLiveItems());
    renderLayout();
    open({ path: ["sa:explore"] });
    const nested = document.querySelector<HTMLButtonElement>('[data-subagent-detail="sa:explore"] [data-subagent-row="sa:gp"]')!;
    fireEvent.click(nested);
    expect(useChatStore.getState().subagentPanel?.path).toEqual(["sa:explore", "sa:gp"]);
    expect(document.querySelector('[data-subagent-detail="sa:gp"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }));
    expect(useChatStore.getState().subagentPanel?.path).toEqual(["sa:explore"]);
    expect(document.querySelector('[data-subagent-detail="sa:explore"]')).not.toBeNull();
  });

  it("updates live: the pending note gives way to the reply when the subagent finishes", () => {
    const items = claudeLiveItems();
    seed(items);
    renderLayout();
    open({ path: ["sa:plan"] });
    const detail = () => document.querySelector<HTMLElement>('[data-subagent-detail="sa:plan"]')!;
    expect(detail().querySelector("[data-subagent-pending]")).toHaveTextContent("完成后在这里显示结果。");
    expect(detail().querySelector("[data-chat-steps]")).toHaveAttribute("data-open");
    act(() => {
      seed(items.map((item) => item.id === "sa:plan" ? { ...item, status: "completed", completed_at: at(19), duration_ms: 9000 }
        : item.id === "msg:p1" ? { ...item, status: "completed", completed_at: at(18), text: "数据流：共用 [\"task-trace\", id] 缓存。" } : item) as TraceItem[]);
    });
    // React Query notifies its observers on a timer.
    act(() => { vi.advanceTimersByTime(1); });
    expect(detail().querySelector("[data-subagent-pending]")).toBeNull();
    expect(detail().querySelector("[data-subagent-reply]")).toHaveTextContent("数据流：共用 [\"task-trace\", id] 缓存。");
  });

  it("shows a failure with its text and a stopped subagent's output before it stopped", () => {
    seed(claudeDoneItems(), "completed");
    renderLayout();
    open({ path: ["sa:fail"], live: false });
    const error = document.querySelector<HTMLElement>("[data-subagent-error]")!;
    expect(error).toHaveTextContent("错误");
    expect(error).toHaveTextContent("Error: connect ETIMEDOUT open.feishu.cn:443");
    act(() => { useChatStore.getState().setSubagentPath(["sa:plan"]); });
    expect(document.querySelector("[data-subagent-stopped]")).toHaveTextContent("停止前的输出已列出 3 项");
    expect(document.querySelector("[data-chat-steps-header]")).toHaveTextContent("5s 后已停止");
    // A Codex child has no task bubble: its task was synthetic.
    act(() => { useChatStore.getState().closeSubagentPanel(); });
    seed(codexItems(), "completed");
    open({ path: ["sa:t1"] });
    expect(document.querySelector("[data-subagent-task]")).toBeNull();
    expect(document.querySelector("[data-subagent-reply]")).toHaveTextContent("core 120 个文件");
  });

  it("keeps loading while a multi-page trace has not reached the subagent yet", async () => {
    const all = claudeDoneItems();
    const late = all.find((item) => item.id === "sa:fail")!;
    const firstPage = all.filter((item) => item.type !== "subagent" && item.parent_id === null);
    let release!: () => void;
    const second = new Promise<void>((resolve) => { release = resolve; });
    getTaskTrace.mockImplementation(async (_id: string, { itemCursor }: { itemCursor: number }) => {
      if (itemCursor === 0) return turnPage(traceTurn({ status: "completed" }), firstPage, { next_item_cursor: 5 });
      await second;
      return turnPage(traceTurn({ status: "completed" }), [late]);
    });
    renderLayout();
    open({ path: ["sa:fail"], live: false });
    // The first page landed without the subagent: still loading, not "not found".
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("att_1", { itemCursor: 5, turnId: "turn_1" }));
    await waitFor(() => expect(client.getQueryData<{ state: { items: TraceItem[] } }>(["task-trace", "att_1"])?.state.items.length).toBeGreaterThan(0));
    expect(screen.getByRole("status")).toHaveTextContent("正在加载…");
    expect(screen.queryByText("找不到这个子代理")).toBeNull();
    // The overview says the same instead of 「这一轮没有子代理」.
    act(() => { useChatStore.getState().setSubagentPath([]); });
    expect(screen.getByRole("status")).toHaveTextContent("正在加载…");
    expect(screen.queryByText("这一轮没有子代理")).toBeNull();
    act(() => { useChatStore.getState().setSubagentPath(["sa:fail"]); });
    await act(async () => { release(); });
    await waitFor(() => expect(document.querySelector('[data-subagent-detail="sa:fail"]')).not.toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows what the stream delivered when a live attempt's first read found no trace yet", () => {
    // The read can land while the turn is still queued (`not_found`, pointer_missing); live frames fill the items.
    client.setQueryData(["task-trace", "att_1"], { ...turnTraceCache(turnPage(traceTurn({ status: "running" }), claudeLiveItems())), read: { state: "not_found", format: "v2" } });
    renderLayout();
    open({ path: ["sa:gp"] });
    expect(document.querySelector('[data-subagent-detail="sa:gp"]')).not.toBeNull();
    expect(screen.queryByText("暂无执行过程记录")).toBeNull();
    act(() => { useChatStore.getState().setSubagentPath([]); });
    expect(overviewRow("sa:explore")).toBeInTheDocument();
  });

  it("still explains an empty panel with a read that found no trace", () => {
    client.setQueryData(["task-trace", "att_1"], { ...turnTraceCache(turnPage(traceTurn({ status: "completed" }), [])), read: { state: "not_found", format: "v2" } });
    renderLayout();
    open({ live: false });
    expect(screen.getByText("暂无执行过程记录")).toBeInTheDocument();
  });

  it("reads a finished turn's trace only once it opens, and names a missing subagent", async () => {
    getTaskTrace.mockResolvedValue(turnPage(traceTurn({ status: "completed" }), claudeDoneItems()));
    renderLayout();
    expect(getTaskTrace).not.toHaveBeenCalled();
    open({ path: ["sa:gone"], live: false });
    expect(screen.getByRole("status")).toHaveTextContent("正在加载…");
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("att_1", { itemCursor: 0, turnId: "turn_1" }));
    expect(await screen.findByText("找不到这个子代理")).toBeInTheDocument();
  });

  it("closes on ×, on Esc inside it and on switching chats, not on a click in the conversation", () => {
    seed(claudeLiveItems());
    const view = renderLayout();
    open();
    // It takes focus when it opens, so Esc works at once.
    expect(document.activeElement).toBe(panel());
    fireEvent.click(screen.getByTestId("chat-conversation"));
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(panel()!, { key: "Escape" });
    expect(useChatStore.getState().subagentPanel).toBeNull();
    open();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(useChatStore.getState().subagentPanel).toBeNull();
    open();
    view.switchTo("chat_2");
    expect(useChatStore.getState().subagentPanel).toBeNull();
    expect(panel()).toBeNull();
    // A pending reveal request from the old chat goes too.
    act(() => { useChatStore.getState().revealSubagent("att_1", "sa:plan"); });
    view.switchTo("chat_1");
    expect(useChatStore.getState().subagentReveal).toBeNull();
  });

  it("pushes the conversation aside in a resizable split when the page has room", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    seed(claudeLiveItems());
    renderLayout();
    open();
    expect(document.querySelector('[data-subagent-panel-mode="split"]')).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整子代理面板大小" })).toBeInTheDocument();
    expect(document.querySelector('[data-panel][id="subagents"]')).not.toBeNull();
  });

  it("closes when the floating chat window closes, and stays closed when it reopens", () => {
    seed(claudeLiveItems());
    const view = renderLayout({ presentation: "window" });
    open({ path: ["sa:plan"] });
    expect(document.querySelector('[data-subagent-panel-mode="overlay"]')).not.toBeNull();
    view.setVisible(false);
    expect(useChatStore.getState().subagentPanel).toBeNull();
    expect(panel()).toBeNull();
    view.setVisible(true);
    expect(panel()).toBeNull();
    // Opening it while the window is hidden shows nothing and is dropped.
    view.setVisible(false);
    open();
    expect(panel()).toBeNull();
    expect(useChatStore.getState().subagentPanel).toBeNull();
  });

  it("covers the conversation when there is no room beside it, and in the floating window", () => {
    seed(claudeLiveItems());
    renderLayout({ presentation: "window" });
    open();
    expect(document.querySelector('[data-subagent-panel-mode="overlay"]')).not.toBeNull();
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
  });

  it("is a full-width sheet on a narrow screen", async () => {
    mobile.value = true;
    seed(claudeLiveItems());
    renderLayout();
    open({ path: ["sa:plan"] });
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("data-subagent-panel-mode", "sheet");
    expect(sheet.className).toContain("data-[side=right]:w-full");
    expect(within(sheet).getByRole("button", { name: "返回子代理列表" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "关闭" }));
    expect(useChatStore.getState().subagentPanel).toBeNull();
  });

  it("labels Claude subagents without type or model by name alone (U2)", () => {
    seed([subagent("sa:x", "Count files", { name: "Count files", agent_type: null, model: null, prompt: "Count the files", started_at: T0 }),
      command("c1", [read("a.ts")], { parent_id: "sa:x" })], "completed");
    renderLayout();
    open({ path: ["sa:x"] });
    expect(document.querySelector("[data-subagent-type]")).toBeNull();
    expect(document.querySelector("[data-subagent-meta]")).toBeNull();
    expect(document.querySelector("[data-subagent-panel-header]")).toHaveTextContent("Count files · Count the files");
  });
});
