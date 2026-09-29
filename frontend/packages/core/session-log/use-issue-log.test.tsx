/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type IssueLogBootstrap } from "../api/schemas/session-log";

const socket = vi.hoisted(() => ({ subscribeStream: vi.fn(), onReconnect: vi.fn(() => () => {}) }));
vi.mock("../realtime", () => ({ useWS: () => socket }));
vi.mock("../auth", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "u" } }) }));
vi.mock("../hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("../platform/replica-env", () => ({ useReplicaEnv: () => memoryEnv }));
vi.mock("../api", () => ({ api: { getSessionLog: vi.fn() } }));

const memoryEnv = { hasOpfs: false };
import { useIssueLog } from "./use-issue-log";

const row = (seq: number) => SessionLogEntrySchema.parse({ session_id: "s", id: `r${seq}`, seq,
  kind: "system", revision: 1, body_md: `body ${seq}`, body_html: `<p>body ${seq}</p>`,
  render_version: "v", author_type: "system", author_id: null, metadata: { attachments: [] } });
const initial: IssueLogBootstrap = { sessionId: "s", head: row(0), window: {
  entries: [row(1)], head_seq: 1, log_version: 1, has_more_before: false, has_more_after: false,
} };

describe("useIssueLog visibility lifecycle", () => {
  it("resubscribes after a hidden interval and retains the new stream when the old handle cleans up", async () => {
    const handles: Array<{ fromSeq: number; onFrames: (frames: unknown[]) => void; unsubscribe: ReturnType<typeof vi.fn> }> = [];
    socket.subscribeStream.mockReset().mockImplementation((_stream: string, _id: string,
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
});
