/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type IssueLogBootstrap } from "../api/schemas/session-log";

const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(), onReconnect: vi.fn(() => () => {}) }));
const socketContext = vi.hoisted(() => ({ current: null as null | typeof socket }));
vi.mock("../realtime", () => ({ useWS: () => socketContext.current }));
vi.mock("../auth", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "u" } }) }));
vi.mock("../hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("../platform/replica-env", () => ({ useReplicaEnv: () => memoryEnv }));
vi.mock("../api", () => ({ api: { getSessionLog: vi.fn() } }));

const memoryEnv = { hasOpfs: false };
import { useIssueLog } from "./use-issue-log";
import { IssueLogReplica } from "./issue-log";

const row = (seq: number) => SessionLogEntrySchema.parse({ session_id: "s", id: `r${seq}`, seq,
  kind: "system", revision: 1, body_md: `body ${seq}`, body_html: `<p>body ${seq}</p>`,
  render_version: "v", author_type: "system", author_id: null, metadata: { attachments: [] } });
const initial: IssueLogBootstrap = { sessionId: "s", head: row(0), window: {
  entries: [row(1)], head_seq: 1, log_version: 1, has_more_before: false, has_more_after: false,
} };

describe("useIssueLog visibility lifecycle", () => {
  const originalSubscribeStream = socket.subscribeStream;

  beforeEach(() => {
    socket.subscribeStream = originalSubscribeStream;
    socket.subscribeStream.mockReset();
    socket.onReconnect.mockReset().mockImplementation(() => () => {});
    socketContext.current = { ...socket };
  });

  afterEach(() => {
    socket.subscribeStream = originalSubscribeStream;
    vi.restoreAllMocks();
  });

  it("resubscribes after a hidden interval and retains the new stream when the old handle cleans up", async () => {
    const handles: Array<{ fromSeq: number; onFrames: (frames: unknown[]) => void; unsubscribe: ReturnType<typeof vi.fn> }> = [];
    socket.subscribeStream.mockImplementation((_stream: string, _id: string,
      handlers: { onFrames: (frames: unknown[]) => void }, options: { fromSeq: number }) => {
      const handle = { fromSeq: options.fromSeq, onFrames: handlers.onFrames, unsubscribe: vi.fn() };
      handles.push(handle);
      return handle;
    });
    const hook = renderHook(({ enabled }) => useIssueLog("s", initial, undefined, true, enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(handles).toHaveLength(1));
    expect(handles[0]!.fromSeq).toBe(1);
    hook.rerender({ enabled: false });
    await waitFor(() => expect(handles[0]!.unsubscribe).toHaveBeenCalled());
    expect(handles).toHaveLength(1);
    hook.rerender({ enabled: true });
    await waitFor(() => expect(handles).toHaveLength(2));
    expect(handles[1]!.fromSeq).toBe(1);
    expect(handles[1]!.unsubscribe).not.toHaveBeenCalled();
    await act(async () => {
      handles[1]!.onFrames([{ seq: 2, kind: "entry", payload: row(2) }]);
    });
    await waitFor(() => expect(hook.result.current.snapshot.entries.some(entry => entry.seq === 2)).toBe(true));
    expect(handles[1]!.unsubscribe).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("keeps the subscription when only the WS context object changes", async () => {
    const unsubscribe = vi.fn();
    const offReconnect = vi.fn();
    const disconnect = vi.spyOn(IssueLogReplica.prototype, "disconnect");
    socket.subscribeStream.mockImplementation(() => ({ unsubscribe }));
    socket.onReconnect.mockReturnValue(offReconnect);

    const hook = renderHook(() => useIssueLog("s", initial, undefined, true));
    await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(1));
    socketContext.current = { ...socket };
    hook.rerender();
    socketContext.current = { ...socket };
    hook.rerender();
    socketContext.current = { ...socket };
    hook.rerender();

    expect(socket.subscribeStream).toHaveBeenCalledTimes(1);
    expect(socket.onReconnect).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(offReconnect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("replaces the stream when the subscribe function changes", async () => {
    const firstUnsubscribe = vi.fn();
    const nextUnsubscribe = vi.fn();
    socket.subscribeStream.mockImplementation(() => ({ unsubscribe: firstUnsubscribe }));
    const firstSubscribe = socket.subscribeStream;
    const hook = renderHook(() => useIssueLog("s", initial, undefined, true));
    await waitFor(() => expect(firstSubscribe).toHaveBeenCalledTimes(1));

    const nextSubscribe = vi.fn((_stream: string, _id: string, _handlers: unknown,
      _options: { fromSeq: number }) => ({ unsubscribe: nextUnsubscribe }));
    socket.subscribeStream = nextSubscribe;
    socketContext.current = { ...socket };
    hook.rerender();
    await waitFor(() => expect(nextSubscribe).toHaveBeenCalledTimes(1));

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(nextSubscribe.mock.calls[0]?.[3]).toEqual({ fromSeq: 1 });
    expect(nextUnsubscribe).not.toHaveBeenCalled();
    hook.unmount();
  });
});
