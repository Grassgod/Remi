import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TraceItem } from "@multiremi/contracts/trace";
import { ApiError } from "@multiremi/core/api";
import { createChatStore, registerChatStore, useChatStore, type SubagentPanelTarget } from "@multiremi/core/chat";
import { chatKeys } from "@multiremi/core/chat/queries";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import type { ChatBackgroundTask } from "@multiremi/core/types";
import { renderWithI18n } from "../../test/i18n";
import { at, subagent, traceTurn, turnPage, turnTraceCache } from "../../test/trace-fixtures";
import { BG_SESSION, bgSnapshot, bgTask } from "../lib/__fixtures__/background-tasks";
import { DoorbellRow } from "./doorbell-row";
import { SubagentPanelLayout } from "./subagent-panel";
import { ChatRunningStrip } from "./subagent-running-strip";

const { api, mobile } = vi.hoisted(() => ({
  api: { getTaskTrace: vi.fn(), listChatBackgroundTasks: vi.fn(), stopChatBackgroundTasks: vi.fn(), getTask: vi.fn() },
  mobile: { value: false },
}));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: () => {} }));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

const values = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); },
} }));

let client: QueryClient;
const KEY = chatKeys.backgroundTasks("ws-1", BG_SESSION);

/** Writes the registry cache; React Query tells its observers on the next tick. */
function seedTasks(rows: ChatBackgroundTask[]) {
  act(() => {
    client.setQueryData(KEY, bgSnapshot(rows));
    vi.advanceTimersByTime(0);
  });
}

function seedTrace(items: TraceItem[]) {
  client.setQueryData(["task-trace", "att_1"], turnTraceCache(turnPage(traceTurn({ status: "running" }), items)));
}

function open(target: Partial<SubagentPanelTarget> = {}) {
  act(() => {
    useChatStore.getState().openSubagentPanel({ sessionId: BG_SESSION, view: "tasks", attemptId: null, live: false, path: [], ...target });
  });
}

function renderPanel(locale: "zh-Hans" | "en" = "zh-Hans") {
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <SubagentPanelLayout sessionId={BG_SESSION} presentation="page">
        <div data-testid="chat-conversation">conversation</div>
      </SubagentPanelLayout>
    </QueryClientProvider>,
    { locale },
  );
}

const panel = () => document.querySelector<HTMLElement>("[data-subagent-panel]")!;
const taskRow = (id: string) => document.querySelector<HTMLElement>(`[data-bg-task-row="bgrow_${id}"]`)!;

const RUNNING = bgTask("dev", { started_at: at(0) });
const CAPPED = bgTask("tests", { name: "npm test", command: "npm test", status: "stopped", stop_reason: "keepalive_cap",
  ended_at: at(500), duration_ms: 500_000, lane_state: "closed", origin_turn_seq: 3, output_tail: "PASS 120\n" });
const BUILT = bgTask("flow", { task_type: "workflow", name: "release-check", command: null, status: "completed",
  ended_at: at(400), duration_ms: 65_000, summary: "All 4 checks passed\nmore", usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 65_000 } });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setCurrentWorkspace("demo", "ws-1");
  act(() => { useChatStore.getState().closeSubagentPanel(); });
  useChatStore.setState({ dismissedBackgroundNotices: [] });
  for (const fn of Object.values(api)) fn.mockReset();
  api.stopChatBackgroundTasks.mockResolvedValue(undefined);
  mobile.value = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(at(600)));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("后台任务 view (PR 6 §8.2)", () => {
  it("opens with no running turn from the session registry, with sections, kept-until and no trace read", () => {
    seedTasks([RUNNING, CAPPED, BUILT]);
    renderPanel();
    open();
    expect(panel()).toHaveAttribute("data-subagent-panel", "tasks");
    expect(panel()).toHaveAttribute("aria-label", "后台任务");
    // One kind only: a plain title, no switch.
    expect(panel().querySelector("[data-panel-switch]")).toBeNull();
    expect(panel().querySelector("[data-subagent-panel-header] h2")).toHaveTextContent("后台任务");
    expect(panel().querySelector('[data-bg-section="running"] h3')).toHaveTextContent("运行中 · 1");
    expect(panel().querySelector('[data-bg-section="done"] h3')).toHaveTextContent("已结束 · 2");
    expect(taskRow("dev")).toHaveTextContent("npm run dev 命令");
    expect(taskRow("dev")).toHaveTextContent("运行中 10m");
    // A running row's second line is its last output line.
    expect(taskRow("dev").querySelector("[data-bg-task-second]")).toHaveTextContent("Local: http://localhost:3000/");
    // Ended: the latest first, with the reason and the turn that started it.
    const done = [...panel().querySelectorAll('[data-bg-section="done"] [data-bg-task-row]')].map((row) => row.getAttribute("data-bg-task-row"));
    expect(done).toEqual(["bgrow_tests", "bgrow_flow"]);
    expect(taskRow("tests")).toHaveTextContent("已停止");
    expect(taskRow("tests").querySelector("[data-bg-task-second]")?.textContent).toMatch(/^已到后台保留时长（2\s?小时） · 来自第 3 轮$/);
    expect(taskRow("flow")).toHaveTextContent("release-check 工作流");
    expect(taskRow("flow")).toHaveTextContent("已完成 · 1m 5s");
    expect(taskRow("flow").querySelector("[data-bg-task-second]")).toHaveTextContent(/^All 4 checks passed$/);
    expect(panel().querySelector("[data-bg-kept-until]")?.textContent).toMatch(/^后台保留到 /);
    // ■ only on running rows.
    expect(taskRow("dev").querySelector("[data-bg-task-stop]")).toHaveAccessibleName("停止 npm run dev");
    expect(taskRow("tests").querySelector("[data-bg-task-stop]")).toBeNull();
    expect(api.getTaskTrace).not.toHaveBeenCalled();
    expect(api.listChatBackgroundTasks).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(taskRow("dev")).toHaveTextContent("运行中 10m 1s");
  });

  it("reads the registry itself when nothing is cached, and says when the chat has no tasks", async () => {
    api.listChatBackgroundTasks.mockResolvedValue(bgSnapshot([]));
    renderPanel();
    open();
    expect(panel().querySelector('[role="status"]')).toHaveTextContent("正在加载…");
    await waitFor(() => expect(panel().querySelector('[data-bg-overview="empty"]')).toHaveTextContent("这个会话没有后台任务"));
    expect(api.listChatBackgroundTasks).toHaveBeenCalledWith(BG_SESSION);
    expect(api.getTaskTrace).not.toHaveBeenCalled();
  });

  it("shows 「子代理 · n | 后台任务 · m」 only while both kinds exist, and switches between them", () => {
    seedTrace([subagent("sa:1", "Explore", { name: "Explore", status: "in_progress", completed_at: null })]);
    renderPanel();
    open({ view: "subagents", attemptId: "att_1", live: true });
    // No background task known: the subagent panel as PR 5 had it.
    expect(panel().querySelector("[data-panel-switch]")).toBeNull();
    seedTasks([RUNNING, CAPPED]);
    const tabs = within(panel().querySelector<HTMLElement>("[data-panel-switch]")!).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["子代理 · 1", "后台任务 · 2"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tabs[1]!);
    expect(useChatStore.getState().subagentPanel).toMatchObject({ view: "tasks", attemptId: "att_1", task: null });
    expect(panel()).toHaveAttribute("data-subagent-panel", "tasks");
    fireEvent.click(within(panel()).getByRole("tab", { name: "子代理 · 1" }));
    expect(panel()).toHaveAttribute("data-subagent-panel", "overview");
    // Tasks but no subagents: the single title again.
    act(() => { useChatStore.getState().closeSubagentPanel(); });
    seedTrace([]);
    open({ attemptId: "att_1", live: true });
    expect(panel().querySelector("[data-panel-switch]")).toBeNull();
  });

  it("opens a task's read-only detail with its command, the live output tail and the footer, and goes back", () => {
    const tail = Array.from({ length: 45 }, (_, index) => `line ${index}`).join("\n");
    seedTasks([{ ...RUNNING, output_tail: tail }]);
    renderPanel();
    open();
    fireEvent.click(within(taskRow("dev")).getByRole("button", { name: "打开后台任务 npm run dev" }));
    expect(panel()).toHaveAttribute("data-subagent-panel", "task");
    const header = panel().querySelector<HTMLElement>("[data-bg-detail-header]")!;
    expect(header).toHaveTextContent("npm run dev");
    expect(header).toHaveTextContent("命令");
    expect(header).toHaveTextContent("运行中 10m");
    expect(panel().querySelector('[data-bg-detail-section="command"] pre')).toHaveTextContent("npm run dev -- --port 3000");
    expect(within(panel()).getByRole("button", { name: "复制命令" })).toBeInTheDocument();
    const output = () => panel().querySelector<HTMLElement>("[data-bg-output]")!;
    expect(output().textContent!.split("\n")).toHaveLength(40);
    expect(output().textContent!.split("\n")[0]).toBe("line 5");
    // The tail is live: a new snapshot shows at once.
    seedTasks([{ ...RUNNING, output_tail: `${tail}\nline 45` }]);
    expect(output().textContent!.split("\n").at(-1)).toBe("line 45");
    expect(panel().querySelector("[data-bg-panel-footer]")?.textContent).toMatch(/^后台保留到 .+；关闭会话或到时会停止。$/);
    expect(panel().querySelector("[data-bg-open-origin]")).toHaveTextContent("查看启动它的那一轮");
    fireEvent.click(within(panel()).getByRole("button", { name: "返回后台任务列表" }));
    expect(panel()).toHaveAttribute("data-subagent-panel", "tasks");
  });

  it("stops one task at once (U3): 正在停止… until the registry answers, 停止请求已发送 after 15 s", async () => {
    seedTasks([RUNNING, bgTask("other", { name: "tail -f log", started_at: at(10) })]);
    renderPanel();
    open();
    fireEvent.click(taskRow("dev").querySelector("[data-bg-task-stop]")!);
    // No confirmation for a single stop.
    expect(document.querySelector("[data-bg-stop-all-confirm]")).toBeNull();
    await waitFor(() => expect(api.stopChatBackgroundTasks).toHaveBeenCalledWith(BG_SESSION, { task_id: "dev" }));
    expect(taskRow("dev")).toHaveTextContent("正在停止…");
    expect(taskRow("dev").querySelector("[data-bg-task-stop]")).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(taskRow("dev")).toHaveTextContent("停止请求已发送，等待电脑响应");
    // The registry reports it stopped by the user.
    seedTasks([{ ...RUNNING, status: "stopped", stop_reason: "user", ended_at: at(615), stop_requested_at: at(600), stop_requested_by: "mem_1" },
      bgTask("other", { name: "tail -f log", started_at: at(10) })]);
    expect(panel().querySelector('[data-bg-section="done"]')).toHaveTextContent("已由你停止");
  });

  it("says why a stop was refused and offers it again", async () => {
    seedTasks([RUNNING]);
    api.stopChatBackgroundTasks.mockRejectedValueOnce(new ApiError("offline", 409, "Conflict", { error: "offline", code: "runtime_offline" }));
    renderPanel();
    open();
    await act(async () => { fireEvent.click(taskRow("dev").querySelector("[data-bg-task-stop]")!); });
    await waitFor(() => expect(taskRow("dev").querySelector('[data-bg-task-second="error"]')).toHaveTextContent("运行这个会话的电脑离线，暂时无法停止"));
    expect(taskRow("dev")).toHaveTextContent("运行中");
    expect(taskRow("dev").querySelector("[data-bg-task-stop]")).toBeEnabled();
    // The detail's 停止: an ended task is reported, and the list is read again.
    api.stopChatBackgroundTasks.mockRejectedValueOnce(new ApiError("ended", 409, "Conflict", { error: "ended", code: "task_not_running" }));
    api.listChatBackgroundTasks.mockResolvedValue(bgSnapshot([RUNNING]));
    fireEvent.click(within(taskRow("dev")).getByRole("button", { name: "打开后台任务 npm run dev" }));
    await act(async () => { fireEvent.click(panel().querySelector("[data-bg-detail-stop]")!); });
    await waitFor(() => expect(panel().querySelector('[data-bg-stop-error="dev"]')).toHaveTextContent("这个后台任务已经结束"));
    expect(api.stopChatBackgroundTasks).toHaveBeenLastCalledWith(BG_SESSION, { task_id: "dev" });
  });

  it("asks before 「全部停止」 only when it stops two or more tasks (U3)", async () => {
    seedTasks([RUNNING, bgTask("other", { name: "tail -f log", started_at: at(10) }), CAPPED]);
    const view = renderPanel();
    open();
    fireEvent.click(panel().querySelector("[data-bg-stop-all]")!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("停止这个会话的 2 个后台任务？");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.stopChatBackgroundTasks).not.toHaveBeenCalled();
    fireEvent.click(panel().querySelector("[data-bg-stop-all]")!);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "全部停止" }));
    await waitFor(() => expect(api.stopChatBackgroundTasks).toHaveBeenCalledWith(BG_SESSION, { all: true }));
    await waitFor(() => expect(taskRow("other")).toHaveTextContent("正在停止…"));
    view.unmount();
    // One running task: no question.
    api.stopChatBackgroundTasks.mockClear();
    seedTasks([RUNNING, CAPPED]);
    renderPanel();
    open();
    fireEvent.click(panel().querySelector("[data-bg-stop-all]")!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(api.stopChatBackgroundTasks).toHaveBeenCalledWith(BG_SESSION, { all: true }));
  });

  it("speaks English with plural forms", () => {
    seedTasks([RUNNING, CAPPED]);
    renderPanel("en");
    open();
    expect(panel().querySelector('[data-bg-section="running"] h3')).toHaveTextContent("Running · 1");
    expect(taskRow("tests").querySelector("[data-bg-task-second]")).toHaveTextContent("Reached the background time limit (2 hours) · From turn 3");
  });
});

describe("running strip with background tasks (PR 6 §8.1)", () => {
  function renderStrip(props: Partial<Parameters<typeof ChatRunningStrip>[0]> = {}) {
    return renderWithI18n(
      <QueryClientProvider client={client}>
        <ChatRunningStrip sessionId={BG_SESSION} source={null} doorbells={new Set()} {...props} />
      </QueryClientProvider>,
      { locale: "zh-Hans" },
    );
  }

  it("shows 「N 个后台任务运行中」 with no running turn, and its chips open the task, with no stop control", () => {
    seedTasks([RUNNING, bgTask("other", { name: "tail -f log", started_at: at(540) }), CAPPED]);
    renderStrip();
    const strip = document.querySelector<HTMLElement>("[data-subagent-strip]")!;
    expect(strip.querySelector("[data-strip-overview]")).toHaveTextContent("2 个后台任务运行中");
    const chips = [...strip.querySelectorAll<HTMLElement>("[data-strip-task-chip]")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["npm run dev· 10m", "tail -f log· 1m"]);
    expect(strip.querySelector("[data-strip-more]")).toBeNull();
    expect(within(strip).queryByRole("button", { name: /^停止/ })).toBeNull();
    fireEvent.click(chips[1]!);
    expect(useChatStore.getState().subagentPanel).toMatchObject({ sessionId: BG_SESSION, view: "tasks", task: { task_id: "other", provider_session_id: "ps_1" } });
    fireEvent.click(strip.querySelector("[data-strip-overview]")!);
    expect(useChatStore.getState().subagentPanel).toMatchObject({ view: "tasks", task: null });
  });

  it("counts both kinds while a turn runs subagents: 「N 个子代理、M 个后台任务运行中」", () => {
    seedTasks([RUNNING]);
    const items = [subagent("sa:1", "Explore", { name: "Explore", status: "in_progress", completed_at: null, started_at: at(590) })];
    renderStrip({ items, source: { sessionId: BG_SESSION, attemptId: "att_1", turnId: "turn_1", live: true } });
    expect(document.querySelector("[data-strip-overview]")).toHaveTextContent("1 个子代理、1 个后台任务运行中");
    expect(document.querySelector('[data-strip-chip="sa:1"]')).not.toBeNull();
    expect(document.querySelector('[data-strip-task-chip="bgrow_dev"]')).not.toBeNull();
    // The count opens the subagents; the panel's switch reaches the tasks.
    fireEvent.click(document.querySelector("[data-strip-overview]")!);
    expect(useChatStore.getState().subagentPanel).toMatchObject({ attemptId: "att_1", path: [] });
    expect(useChatStore.getState().subagentPanel?.view).toBeUndefined();
  });

  it("shows nothing without running tasks or recent ends", () => {
    seedTasks([bgTask("old", { status: "completed", ended_at: at(0), lane_state: "in_attempt" })]);
    renderStrip();
    expect(document.querySelector("[data-subagent-strip]")).toBeNull();
    expect(document.querySelector("[data-bg-ended-notice]")).toBeNull();
  });

  it("explains an end no reply explains for 10 minutes, opens it, and stays closed once dismissed", () => {
    seedTasks([CAPPED, bgTask("mine", { status: "stopped", stop_reason: "user", stop_requested_by: "mem_1", ended_at: at(590) }),
      bgTask("codex", { name: "pytest", status: "completed", ended_at: at(580), lane_state: "parked" }),
      bgTask("rang", { name: "build", status: "completed", ended_at: at(580), lane_state: "parked" })]);
    renderStrip({ doorbells: new Set(["rang"]) });
    const notices = [...document.querySelectorAll<HTMLElement>("[data-bg-ended-notice]")];
    expect(notices.map((notice) => notice.querySelector("span[title]")?.textContent)).toEqual([
      "后台任务 pytest 已完成",
      expect.stringMatching(/^npm test 已停止：已到后台保留时长（2\s?小时）$/),
    ]);
    // No running task: the notices stand alone, without the strip.
    expect(document.querySelector("[data-subagent-strip]")).toBeNull();
    fireEvent.click(within(notices[1]!).getByRole("button", { name: "查看" }));
    expect(useChatStore.getState().subagentPanel).toMatchObject({ view: "tasks", task: { task_id: "tests" } });
    fireEvent.click(within(notices[1]!).getByRole("button", { name: "关闭提示" }));
    expect(document.querySelectorAll("[data-bg-ended-notice]")).toHaveLength(1);
    // Ten minutes after the end it goes by itself.
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(document.querySelectorAll("[data-bg-ended-notice]")).toHaveLength(0);
  });
});

describe("doorbell row (PR 6 §8.1)", () => {
  const doorbell = { task_id: "dev", name: "npm test", task_type: "shell", status: "completed" as const,
    origin_attempt_id: "att_1", origin_turn_id: "turn_1", provider_session_id: "ps_1" };

  it("is one centered line with 查看, which opens the task", () => {
    renderWithI18n(<QueryClientProvider client={client}><DoorbellRow doorbell={doorbell} sessionId={BG_SESSION} /></QueryClientProvider>, { locale: "zh-Hans" });
    const row = document.querySelector<HTMLElement>('[data-doorbell="dev"]')!;
    expect(row).toHaveTextContent("后台任务 npm test 已完成·查看");
    fireEvent.click(within(row).getByRole("button", { name: "查看" }));
    expect(useChatStore.getState().subagentPanel).toMatchObject({ sessionId: BG_SESSION, view: "tasks", task: { task_id: "dev", provider_session_id: "ps_1" } });
  });

  it("says a failure", () => {
    renderWithI18n(<QueryClientProvider client={client}><DoorbellRow doorbell={{ ...doorbell, status: "failed" }} sessionId={BG_SESSION} /></QueryClientProvider>, { locale: "en" });
    expect(document.querySelector('[data-doorbell="dev"]')).toHaveTextContent("Background task npm test failed·View");
  });
});
