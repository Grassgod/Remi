import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { TaskTraceDialog } from "./task-trace-dialog";

const { getTaskTrace, callbacks } = vi.hoisted(() => ({
  getTaskTrace: vi.fn(), callbacks: { current: null as null | Record<string, (...args: never[]) => void> },
}));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: (_id: string, value: typeof callbacks.current) => { callbacks.current = value; } }));
vi.mock("./agent-transcript-dialog", () => ({ AgentTranscriptDialog: (props: {
  task: { id: string }; items: { content?: string }[]; isLive: boolean; traceResult?: { closed: boolean }; traceError: boolean; traceModel?: string;
}) => <div data-testid="projection">{JSON.stringify({ task: props.task.id, content: props.items.map(i => i.content), live: props.isLive, closed: props.traceResult?.closed, error: props.traceError, model: props.traceModel })}</div> }));

const task = { id: "a", agent_id: "agent", status: "running", issue_id: "issue" };
const page = (content: string, model?: string) => ({ events: [
  { seq: 1, ts: "2026-10-05T00:00:00Z", type: "text", content },
  ...(model ? [{ seq: 2, ts: "2026-10-05T00:00:00Z", type: "execution", meta: { model } }] : []),
], next_after_seq: model ? 2 : 1, head: model ? 2 : 1, eof: true, closed: false, source: "daemon", state: "ok" });
beforeEach(() => { getTaskTrace.mockReset(); callbacks.current = null; });

it("switching tasks removes the previous task's trace", async () => {
  getTaskTrace.mockResolvedValueOnce(page("A trace", "model-a")).mockResolvedValueOnce({ ...page(""), events: [], head: 0, next_after_seq: 0 });
  const view = render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent("A trace"));
  expect(screen.getByTestId("projection")).toHaveTextContent("model-a");
  view.rerender(<TaskTraceDialog task={{ ...task, id: "b" } as never} agentName="Agent" onOpenChange={() => {}} />);
  await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("b", 0, 200, undefined));
  expect(screen.getByTestId("projection")).not.toHaveTextContent("A trace");
  expect(screen.getByTestId("projection")).not.toHaveTextContent("model-a");
});

it("an old pending read cannot contaminate a different task", async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  getTaskTrace.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(page("B trace", "model-b"));
  const view = render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />);
  view.rerender(<TaskTraceDialog task={{ ...task, id: "b" } as never} agentName="Agent" onOpenChange={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent("B trace"));
  await act(async () => { release(page("A trace", "model-a")); });
  expect(screen.getByTestId("projection")).toHaveTextContent("B trace");
  expect(screen.getByTestId("projection")).not.toHaveTextContent("A trace");
  expect(screen.getByTestId("projection")).toHaveTextContent("model-b");
  expect(screen.getByTestId("projection")).not.toHaveTextContent("model-a");
});

it("surfaces refused streams and stops the live state", async () => {
  getTaskTrace.mockResolvedValue(page("Initial trace"));
  render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent("Initial trace"));
  act(() => callbacks.current?.onError?.({ code: "forbidden" } as never));
  expect(screen.getByTestId("projection")).toHaveTextContent('"error":true');
  expect(screen.getByTestId("projection")).toHaveTextContent('"live":false');
});

it("a live closed signal survives an older pending HTTP response", async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  getTaskTrace.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />);
  act(() => callbacks.current?.onClosed?.({ head_seq: 1 } as never));
  await act(async () => release(page("Final trace")));
  expect(screen.getByTestId("projection")).toHaveTextContent('"closed":true');
  expect(screen.getByTestId("projection")).toHaveTextContent('"live":false');
});
