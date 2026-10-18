/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, renderHook as testingRenderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type IssueLogBootstrap } from "../api/schemas/session-log";

const renderHook: typeof testingRenderHook = (callback, options) => {
  const client = new QueryClient();
  return testingRenderHook(callback, {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>, ...options,
  });
};
const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(), onReconnect: vi.fn(() => () => {}) }));
const socketContext = vi.hoisted(() => ({ current: null as null | typeof socket }));
vi.mock("../realtime", () => ({ useWS: () => socketContext.current }));
vi.mock("../auth", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "u" } }) }));
vi.mock("../hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("../platform/replica-env", () => ({ useReplicaEnv: () => memoryEnv }));
vi.mock("../api", () => ({ api: { getSessionLog: vi.fn() } }));

const memoryEnv = { hasOpfs: false };
import { useChatLog, useIssueLog } from "./use-issue-log";
import { IssueLogReplica } from "./issue-log";
import { chatLogPool, chatLogScope, clearChatLogPool } from "./chat-log-pool";
import { api } from "../api";
import type { HubStreamAckPayload } from "@multiremi/contracts/live-hub";

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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the session without an error when crypto.randomUUID is unavailable over http", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    socket.subscribeStream.mockReturnValue({ unsubscribe: vi.fn() });
    const hook = renderHook(() => useIssueLog("s", initial));
    try {
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledOnce());
      expect(hook.result.current.error).toBe(false);
      expect(hook.result.current.snapshot.ready).toBe(true);
      expect(hook.result.current.snapshot.entries.map(entry => entry.id)).toEqual(["r0", "r1"]);
    } finally { hook.unmount(); }
  });

  it.each([false, true])("fills a write between window read and subscribe through the actual onGap (ack=%s)", async withAck => {
    const events: string[] = [];
    const first = { ...row(1), kind: "message" };
    const next = { ...row(2), kind: "message", body_md: "written behind the read barrier", metadata: { attachments: [], reactions: [{ emoji: "+1" }] } };
    let stored = [first];
    vi.mocked(api.getSessionLog).mockImplementation(async (_id, params = {}) => {
      if (params.anchor === 0) return { ...initial.window, entries: [row(0)] };
      events.push(`read:${stored.length}`);
      return { ...initial.window, entries: [...stored], head_seq: stored.length };
    });
    socket.subscribeStream.mockImplementation((_stream, _id, handlers: {
      onAck: (ack: HubStreamAckPayload) => void; onGap: () => void;
    }, options: { fromSeq: number }) => {
      // Deterministic barrier: the tail reader has returned; the wire has not subscribed yet.
      expect(events).toEqual(["read:1"]);
      expect(options.fromSeq).toBe(2);
      if (withAck) handlers.onAck({ stream: "log", id: "s", first_seq: 0, head_seq: 1, log_version: 1, gap: null });
      stored = [first, next]; events.push("write:2"); events.push("subscribe:2");
      handlers.onGap(); events.push("onGap");
      return { unsubscribe: vi.fn() };
    });
    const hook = renderHook(() => useIssueLog("s"));
    try {
      await waitFor(() => expect(hook.result.current.snapshot.entries.filter(entry => entry.id === next.id)).toHaveLength(1));
      expect(events).toEqual(["read:1", "write:2", "subscribe:2", "read:2", "onGap"]);
      expect(hook.result.current.snapshot.entries.find(entry => entry.id === next.id)).toEqual(next);
      expect(hook.result.current.error).toBe(false);
    } finally { hook.unmount(); vi.mocked(api.getSessionLog).mockReset(); }
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
    expect(handles[0]!.fromSeq).toBe(2);
    hook.rerender({ enabled: false });
    await waitFor(() => expect(handles[0]!.unsubscribe).toHaveBeenCalled());
    expect(handles).toHaveLength(1);
    hook.rerender({ enabled: true });
    await waitFor(() => expect(handles).toHaveLength(2));
    expect(handles[1]!.fromSeq).toBe(2);
    expect(handles[1]!.unsubscribe).not.toHaveBeenCalled();
    await act(async () => {
      handles[1]!.onFrames([{ seq: 2, kind: "entry", payload: row(2) }]);
    });
    await waitFor(() => expect(hook.result.current.snapshot.entries.some(entry => entry.seq === 2)).toBe(true));
    expect(handles[1]!.unsubscribe).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("batches log frames into cursor, message and turn surface invalidations", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let onFrames: (frames: unknown[]) => void = () => {};
    socket.subscribeStream.mockImplementation((_stream, _id, handlers) => {
      onFrames = handlers.onFrames;
      return { unsubscribe: vi.fn() };
    });
    const hook = renderHook(() => useIssueLog("s", initial), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledOnce());
    await act(async () => {
      onFrames([{ seq: 2, kind: "entry", payload: row(2) }]);
      onFrames([{ seq: 3, kind: "entry", payload: row(3) }]);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox", "w"] }));
    expect(invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === "inbox")).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["message-detail", "w"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["turns", "w"] });
    hook.unmount();
    client.clear();
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
    expect(nextSubscribe.mock.calls[0]?.[3]).toEqual({ fromSeq: 2 });
    expect(nextUnsubscribe).not.toHaveBeenCalled();
    hook.unmount();
  });
});

describe("useChatLog pool", () => {
  type Params = { anchor?: number; before?: number; after?: number };
  const chatRow = (sessionId: string, seq: number) => SessionLogEntrySchema.parse({ ...row(seq), session_id: sessionId, id: `${sessionId}-${seq}` });
  const ids = (snapshot: { entries: readonly { id: string }[] }) => snapshot.entries.map(entry => entry.id);
  let logs: Record<string, number[]>;
  let reads: Array<[string, Params]>;
  let hold: Promise<void> | null;

  beforeEach(() => {
    logs = { a: [1, 2], b: [1] };
    reads = [];
    hold = null;
    socket.subscribeStream.mockReset().mockImplementation(() => ({ unsubscribe: vi.fn() }));
    socket.onReconnect.mockReset().mockImplementation(() => () => {});
    socketContext.current = { ...socket };
    vi.mocked(api.getSessionLog).mockReset().mockImplementation(async (id: string, params: Params = {}) => {
      reads.push([id, params]);
      if (hold) await hold;
      const entries = logs[id]!.filter(seq => params.anchor === undefined || seq > params.anchor).map(seq => chatRow(id, seq));
      return { entries, head_seq: logs[id]!.at(-1)!, log_version: 1, has_more_before: false, has_more_after: false };
    });
  });
  afterEach(() => { clearChatLogPool(); });

  it("paints a chat shown again from its retained rows, then refreshes its tail once in the background", async () => {
    const hook = renderHook(({ id }) => useChatLog(id), { initialProps: { id: "a" } });
    try {
      await waitFor(() => expect(ids(hook.result.current.snapshot)).toEqual(["a-1", "a-2"]));
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(1));
      const first = hook.result.current.replica;
      hook.rerender({ id: "b" });
      await waitFor(() => expect(ids(hook.result.current.snapshot)).toEqual(["b-1"]));
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(2));

      // Chat a gets a reply while b is shown; its next read is slow.
      logs.a = [1, 2, 3];
      let answer!: () => void;
      hold = new Promise(resolve => { answer = resolve; });
      const before = reads.length;
      hook.rerender({ id: "a" });
      // The same log, painted before any read answers.
      expect(hook.result.current.replica).toBe(first);
      expect(hook.result.current.snapshot.ready).toBe(true);
      expect(ids(hook.result.current.snapshot)).toEqual(["a-1", "a-2"]);
      expect(reads.slice(before)).toEqual([["a", { before: 30 }]]);
      // The stream waits for the refresh, as after a first read.
      expect(socket.subscribeStream).toHaveBeenCalledTimes(2);

      await act(async () => { answer(); });
      await waitFor(() => expect(ids(hook.result.current.snapshot)).toEqual(["a-1", "a-2", "a-3"]));
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(3));
      expect(socket.subscribeStream.mock.calls[2]?.[1]).toBe("a");
      expect(socket.subscribeStream.mock.calls[2]?.[3]).toEqual({ fromSeq: 4 });
      expect(reads.slice(before)).toEqual([["a", { before: 30 }]]);
      expect(hook.result.current.error).toBe(false);
      // Chat never reads the seq-0 head.
      expect(reads.some(([, params]) => params.anchor === 0 && params.before === 1)).toBe(false);
    } finally { hook.unmount(); }
  });

  it("releases a hidden chat and refreshes it when shown again; an Issue log still reads its head", async () => {
    const hook = renderHook(({ enabled }) => useChatLog("a", undefined, enabled), { initialProps: { enabled: true } });
    const issue = renderHook(() => useIssueLog("b"));
    try {
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(2));
      expect(reads).toContainEqual(["b", { anchor: 0, before: 1 }]);
      expect(reads.filter(([id]) => id === "a")).toEqual([["a", { before: 30 }]]);
      const replica = hook.result.current.replica;
      hook.rerender({ enabled: false });
      // Hidden means released: the pool would lease it to the next holder.
      const probe = chatLogPool.acquire(chatLogScope("u", "w")!, "a", replica);
      expect(probe?.retained).toBe(true);
      probe!.release();
      expect(ids(hook.result.current.snapshot)).toEqual(["a-1", "a-2"]);
      hook.rerender({ enabled: true });
      expect(hook.result.current.replica).toBe(replica);
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(3));
      expect(reads.filter(([id]) => id === "a")).toEqual([["a", { before: 30 }], ["a", { before: 30 }]]);
    } finally { hook.unmount(); issue.unmount(); }
  });

  it("gives a second window showing the same chat a log of its own", async () => {
    const one = renderHook(() => useChatLog("a"));
    const two = renderHook(() => useChatLog("a"));
    try {
      await waitFor(() => expect(socket.subscribeStream).toHaveBeenCalledTimes(2));
      expect(two.result.current.replica).not.toBe(one.result.current.replica);
      expect(chatLogPool.peek(chatLogScope("u", "w")!, "a")).toBe(one.result.current.replica);
      await waitFor(() => expect(ids(two.result.current.snapshot)).toEqual(["a-1", "a-2"]));
    } finally { one.unmount(); two.unmount(); }
  });
});
