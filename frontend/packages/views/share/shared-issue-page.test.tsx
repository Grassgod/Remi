import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask, SharedTaskTracePage } from "@multiremi/core/types";
import common from "../locales/zh-Hans/common.json";
import issues from "../locales/zh-Hans/issues.json";

const getSharedTaskTrace = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({ api: { getSharedTaskTrace } }));

import { SharedTask, messageText, traceEventToMessage } from "./shared-issue-page";

const task = { id: "tsk_share", agent_id: "agt_share", status: "completed" } as unknown as AgentTask;
const resources = { "zh-Hans": { common, issues } };

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

function page(overrides: Partial<SharedTaskTracePage> = {}): SharedTaskTracePage {
  return {
    events: [], next_after_seq: 0, head: 0, eof: true, closed: true,
    source: "archive", state: "ok", ...overrides,
  };
}

beforeEach(() => getSharedTaskTrace.mockReset());
afterEach(() => vi.clearAllMocks());

describe("SharedTask trace expansion", () => {
  it("does not request the trace while collapsed", () => {
    renderTask();
    expect(getSharedTaskTrace).not.toHaveBeenCalled();
  });

  it("loads all pages in seq order after expansion without a load-more control", async () => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockImplementation(async (_token: string, _taskId: string, afterSeq: number) =>
      afterSeq === 0
        ? page({ events: [{ seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "first" }], next_after_seq: 1, head: 3, eof: false })
        : page({ events: [{ seq: 3, ts: "2026-09-28T00:00:01Z", type: "text", content: "third" }], next_after_seq: 3, head: 3 }));
    renderTask();
    await user.click(screen.getByText("agt_share"));
    await waitFor(() => expect(screen.getByText("third")).toBeInTheDocument());
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(getSharedTaskTrace.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    expect(screen.queryByText(/加载更多/)).not.toBeInTheDocument();
  });

  it.each([
    ["unreachable", "daemon〈Desk〉当前离线", "Desk"],
    ["lost", "已随 daemon 退役丢失", undefined],
    ["backfilling", "归档回填中", undefined],
    ["not_found", null, undefined],
  ] as const)("renders %s without trace events", async (state, expected, runtimeName) => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockResolvedValue(page({ state, source: null, runtime_name: runtimeName }));
    renderTask();
    await user.click(screen.getByText("agt_share"));
    await waitFor(() => expect(getSharedTaskTrace).toHaveBeenCalledTimes(1));
    if (expected) expect(await screen.findByText(expected)).toBeInTheDocument();
    else await waitFor(() => expect(screen.queryByText("正在加载过程记录…")).not.toBeInTheDocument());
    expect(screen.queryByText("text")).not.toBeInTheDocument();
  });

  it("retries a network failure when closed and reopened", async () => {
    const user = userEvent.setup();
    getSharedTaskTrace.mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(page({ events: [{ seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "recovered" }], next_after_seq: 1, head: 1 }));
    renderTask();
    await user.click(screen.getByText("agt_share"));
    expect(await screen.findByText("过程记录加载失败，请收起后重试")).toBeInTheDocument();
    await user.click(screen.getByText("agt_share"));
    await user.click(screen.getByText("agt_share"));
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(getSharedTaskTrace).toHaveBeenCalledTimes(2);
  });

  it.each([
    { seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "\u0001".repeat(180_000) },
    { seq: 1, ts: "2026-09-28T00:00:00Z", type: "tool_result", tool: "Bash",
      tool_call_id: "i".repeat(1024 * 1024 + 1000), status: "completed", output: "" },
    { seq: 1, ts: "2026-09-28T00:00:00Z", type: "tool_result", tool: "Bash",
      tool_call_id: "call_output", status: "completed", output: "\u0001".repeat(180_000) },
  ])("renders an oversized $type completely and automatically pages to eof", async (event) => {
    getSharedTaskTrace.mockImplementation(async (_token: string, _taskId: string, afterSeq: number) => afterSeq === 0
      ? page({ events: [event], next_after_seq: 1, head: 2, eof: false })
      : page({ events: [{ seq: 2, ts: "2026-09-28T00:00:01Z", type: "text", content: "last" }], next_after_seq: 2, head: 2 }));
    renderTask();
    await userEvent.setup().click(screen.getByText("agt_share"));
    expect(await screen.findByText("last")).toBeInTheDocument();
    const expected = event.content || event.output || JSON.stringify(event, null, 2);
    expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === expected)).toBeInTheDocument();
    expect(screen.queryByText(/内容过长已截断/)).not.toBeInTheDocument();
    expect(getSharedTaskTrace.mock.calls.map((call) => call[2])).toEqual([0, 1]);
  });

  it("renders the same content from legacy inline messages and trace events", async () => {
    const fixtures = [
      { seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "same text" },
      { seq: 2, ts: "2026-09-28T00:00:01Z", type: "tool_result", output: "same output" },
      { seq: 3, ts: "2026-09-28T00:00:02Z", type: "tool_use", input: { command: "ls" } },
    ];
    const legacy = fixtures.map((event) => ({ ...event, id: `msg_${event.seq}` }));
    const user = userEvent.setup();
    getSharedTaskTrace.mockResolvedValue(page({ events: fixtures, next_after_seq: 3, head: 3 }));
    renderTask();
    await user.click(screen.getByText("agt_share"));
    await waitFor(() => expect(screen.getByText("same output")).toBeInTheDocument());
    for (const [index, event] of fixtures.entries()) {
      const oldText = messageText(legacy[index]!);
      const newText = messageText(traceEventToMessage(event));
      expect(newText).toBe(oldText);
      expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === newText)).toBeInTheDocument();
    }
  });

  it.each([
    { type: "text", content: "same text" },
    { type: "tool_result", output: "same output" },
    { type: "tool_use", input: { command: "ls" } },
    { type: "tool_result", tool: "Bash", tool_call_id: "call_qa", status: "completed", output: "" },
    { type: "execution", meta: { model: "test-model", phase: "start" } },
    { type: "usage", meta: { input_tokens: 12, output_tokens: 34 } },
    { type: "future_type", meta: { future_field: "preserved" }, extension: "unknown information" },
  ])("preserves legacy presentation for $type ($content$output)", async (fields) => {
    const event = {
      seq: 1, ts: "2026-09-28T00:00:00Z", tool: null, content: null,
      output: null, input: null, tool_call_id: null, status: null, meta: null, ...fields,
    };
    const { ts, tool_call_id, ...commonFields } = event;
    const legacy = { ...commonFields, id: "msg_legacy", taskId: task.id, createdAt: ts, toolCallId: tool_call_id };
    getSharedTaskTrace.mockResolvedValue(page({ events: [event], next_after_seq: 1, head: 1 }));
    renderTask();
    await userEvent.setup().click(screen.getByText("agt_share"));
    const newText = messageText(traceEventToMessage(event));
    await waitFor(() => expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === newText)).toBeInTheDocument());
    const oldText = messageText(legacy);
    if (event.content || event.output || event.input) {
      expect(newText).toBe(oldText);
    } else {
      const { id, taskId, createdAt, toolCallId, ...oldFields } = JSON.parse(oldText);
      expect(JSON.parse(newText)).toEqual({ ...oldFields, ts: createdAt, tool_call_id: toolCallId });
      expect(newText).toBe(JSON.stringify(event, null, 2));
      expect(newText).not.toContain(id);
      expect(newText).not.toContain(taskId);
    }
  });

  it("QA B5: retains legacy tool identity and status when payload text is empty", async () => {
    const event = {
      seq: 1, ts: "2026-09-28T00:00:00Z", type: "tool_result", tool: "Bash",
      tool_call_id: "call_qa", status: "completed", content: null, output: "", input: null,
    };
    getSharedTaskTrace.mockResolvedValue(page({ events: [event], next_after_seq: 1, head: 1 }));
    renderTask();
    await userEvent.setup().click(screen.getByText("agt_share"));
    await waitFor(() => {
      const pre = screen.getByText((_, element) => element?.tagName === "PRE" && Boolean(element.textContent?.includes("call_qa")));
      expect(pre).toHaveTextContent("Bash");
      expect(pre).toHaveTextContent("completed");
    });
  });
});
