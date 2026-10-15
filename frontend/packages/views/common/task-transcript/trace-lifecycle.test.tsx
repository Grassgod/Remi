import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { message, traceTurn, turnPage } from "../../test/trace-fixtures";
import { TaskTraceDialog } from "./task-trace-dialog";

const { getTaskTrace, callbacks } = vi.hoisted(() => ({
  getTaskTrace: vi.fn(), callbacks: { current: null as null | Record<string, (...args: never[]) => void> },
}));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: (_id: string, value: typeof callbacks.current) => { callbacks.current = value; } }));
vi.mock("./agent-transcript-dialog", () => ({ AgentTranscriptDialog: (props: {
  task: { id: string }; items: { id: string; text?: string }[]; isLive: boolean; traceClosed: boolean; traceError: boolean;
  turn: { model: string | null } | null;
}) => <div data-testid="projection">{JSON.stringify({ task: props.task.id, content: props.items.map((i) => i.text), live: props.isLive,
  closed: props.traceClosed, error: props.traceError, model: props.turn?.model ?? null })}</div> }));

const task = { id: "a", agent_id: "agent", status: "running", issue_id: "issue" };
const page = (content: string, model: string | null = null) =>
  turnPage(traceTurn({ id: "a", model }), [message("msg:1", content)], { closed: false });
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  getTaskTrace.mockReset(); callbacks.current = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

it("switching tasks removes the previous task's trace", async () => {
  getTaskTrace.mockResolvedValueOnce(page("A trace", "model-a")).mockResolvedValueOnce(turnPage(traceTurn({ id: "b" }), []));
  const view = render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />, { wrapper });
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent("A trace"));
  expect(screen.getByTestId("projection")).toHaveTextContent("model-a");
  view.rerender(<TaskTraceDialog task={{ ...task, id: "b" } as never} agentName="Agent" onOpenChange={() => {}} />);
  await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("b", { itemCursor: 0, turnId: undefined }));
  expect(screen.getByTestId("projection")).not.toHaveTextContent("A trace");
  expect(screen.getByTestId("projection")).not.toHaveTextContent("model-a");
});

it("an old pending read cannot contaminate a different task", async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  getTaskTrace.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValueOnce(page("B trace", "model-b"));
  const view = render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />, { wrapper });
  view.rerender(<TaskTraceDialog task={{ ...task, id: "b" } as never} agentName="Agent" onOpenChange={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent("B trace"));
  await act(async () => { release(page("A trace", "model-a")); });
  expect(screen.getByTestId("projection")).toHaveTextContent("B trace");
  expect(screen.getByTestId("projection")).not.toHaveTextContent("A trace");
  expect(screen.getByTestId("projection")).toHaveTextContent("model-b");
});

it("surfaces refused streams and stops the live state", async () => {
  getTaskTrace.mockResolvedValue(page("Initial trace"));
  render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />, { wrapper });
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent("Initial trace"));
  act(() => callbacks.current?.onError?.({ code: "forbidden" } as never));
  expect(screen.getByTestId("projection")).toHaveTextContent('"error":true');
  expect(screen.getByTestId("projection")).toHaveTextContent('"live":false');
});

it("a live closed signal survives an older pending HTTP response", async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  getTaskTrace.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  render(<TaskTraceDialog task={task as never} agentName="Agent" onOpenChange={() => {}} />, { wrapper });
  act(() => callbacks.current?.onClosed?.({ head_seq: 1 } as never));
  await act(async () => release(page("Final trace")));
  await waitFor(() => expect(screen.getByTestId("projection")).toHaveTextContent('"closed":true'));
  expect(screen.getByTestId("projection")).toHaveTextContent('"live":false');
  expect(screen.getByTestId("projection")).toHaveTextContent("Final trace");
});
