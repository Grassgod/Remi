import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask } from "@multiremi/core/types";
import chat from "../locales/zh-Hans/chat.json";
import common from "../locales/zh-Hans/common.json";
import issues from "../locales/zh-Hans/issues.json";
import {
  change, command, fileChange, message, read, subagent, traceTurn, turnPage, unknown,
} from "../test/trace-fixtures";

const getSharedTaskTrace = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: { getSharedTaskTrace } }));

import { SharedTask } from "./shared-issue-page";

const task = { id: "tsk_share", agent_id: "agt_share", status: "completed" } as unknown as AgentTask;
const resources = { "zh-Hans": { common, issues, chat } };
const done = traceTurn({ status: "completed" });

function renderTask() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider locale="zh-Hans" resources={resources}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </I18nProvider>
    );
  }
  return render(<SharedTask task={task} actors={[]} token="shr_test" />, { wrapper: Wrapper });
}

beforeEach(() => getSharedTaskTrace.mockReset());
afterEach(() => vi.clearAllMocks());

describe("SharedTask trace expansion", () => {
  it("does not request the trace while collapsed", () => {
    renderTask();
    expect(getSharedTaskTrace).not.toHaveBeenCalled();
  });

  it("loads every item page after expansion and renders one line per item in the step copy", async () => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockImplementation(async (_token: string, _taskId: string, cursor: number) => cursor === 0
      ? turnPage(done, [command("cmd_1", [read("src/app.ts")]), fileChange("fc_1", [change("src/app.ts")])], { next_item_cursor: 2 })
      : turnPage(done, [subagent("sub_1", "Explore"), command("cmd_c", [unknown("bun test")], { parent_id: "sub_1" }),
        message("msg:f", "全部完成", "final")]));
    const view = renderTask();
    await user.click(screen.getByText("agt_share"));
    await waitFor(() => expect(screen.getByText("全部完成")).toBeInTheDocument());
    expect(getSharedTaskTrace.mock.calls.map((call) => call[2])).toEqual([0, 2]);
    expect([...view.container.querySelectorAll("[data-shared-trace-item]")].map((line) => line.textContent)).toEqual([
      "已读取 app.ts", "已编辑 app.ts", "子代理已完成：Explore", "已运行 bun test", "全部完成",
    ]);
    // A subagent's own steps sit under it.
    const child = [...view.container.querySelectorAll<HTMLElement>("[data-shared-trace-item]")][3]!;
    expect(child.style.paddingLeft).toBe("16px");
    expect(screen.queryByText(/加载更多/)).not.toBeInTheDocument();
  });

  it.each([
    ["unreachable", "daemon〈Desk〉当前离线", "Desk"],
    ["lost", "此执行过程已不可查看", undefined],
    ["not_found", null, undefined],
  ] as const)("renders %s without trace items", async (state, expected, runtimeName) => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockResolvedValue(turnPage(null, [], { state, source: null, runtime_name: runtimeName }));
    const view = renderTask();
    await user.click(screen.getByText("agt_share"));
    await waitFor(() => expect(getSharedTaskTrace).toHaveBeenCalledTimes(1));
    if (expected) expect(await screen.findByText(expected)).toBeInTheDocument();
    else await waitFor(() => expect(screen.queryByText("正在加载过程记录…")).not.toBeInTheDocument());
    expect(view.container.querySelectorAll("[data-shared-trace-item]")).toHaveLength(0);
  });

  it("shows nothing and no label for a legacy trace", async () => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockResolvedValue(turnPage(null, [], { format: "legacy", closed: true }));
    const view = renderTask();
    await user.click(screen.getByText("agt_share"));
    await waitFor(() => expect(screen.queryByText("正在加载过程记录…")).not.toBeInTheDocument());
    expect(view.container.querySelector("details > div")?.textContent).toBe("");
  });

  it("retries a network failure when closed and reopened", async () => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(turnPage(done, [message("msg:f", "recovered", "final")]));
    renderTask();
    await user.click(screen.getByText("agt_share"));
    expect(await screen.findByText("过程记录加载失败，请收起后重试")).toBeInTheDocument();
    await user.click(screen.getByText("agt_share"));
    await user.click(screen.getByText("agt_share"));
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(getSharedTaskTrace).toHaveBeenCalledTimes(2);
  });

  it("stops when the item cursor does not advance", async () => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockResolvedValue(turnPage(done, [message("msg:1", "x")], { next_item_cursor: 0 }));
    renderTask();
    await user.click(screen.getByText("agt_share"));
    expect(await screen.findByText("过程记录加载失败，请收起后重试")).toBeInTheDocument();
  });
});
