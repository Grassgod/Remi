// MUL-474 (MUL-383 S8e): deterministic fixture for the browser task-message fan-out.
//
// `notifyBrowserTaskMessages` was narrowed from a whole `MultiremiTask` to a
// `TaskMessageFanoutSubject` (six routing/scope fields) so that appending a
// message no longer loads the prompt. The frames a browser receives are a
// contract, so this fixture reproduces both fan-out branches — the
// workspace-wide one that filters by task visibility, and the Chat-scoped one —
// and the golden compares the emitted bytes.
//
// The clock and id generation are pinned the same way
// `issue-detail-first-screen-fixture.ts` pins them: `created_at` is part of the
// frame, so without a fixed clock the comparison would only be a shape check.
import type { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import type {
  BrowserScopeWebSocketRegistry,
  BrowserWebSocketRegistry,
  MultiremiWebSocketClient,
} from "@multiremi/api/helpers.js";

export const FANOUT_WORKSPACE_TASK_ID = "tsk_fanout_workspace";
export const FANOUT_CHAT_TASK_ID = "tsk_fanout_chat";
export const FANOUT_CHAT_SESSION_ID = "chs_fanout";

export interface FanoutClient {
  client: MultiremiWebSocketClient;
  frames: string[];
}

/** A browser WebSocket double that records the raw frame text it is handed. */
export function fanoutBrowserClient(userId: string): FanoutClient {
  const frames: string[] = [];
  return {
    client: {
      data: {
        kind: "browser",
        connectedAt: "2026-09-27T00:00:00.000Z",
        workspaceId: "local",
        authenticated: true,
        userId,
        accessToken: null,
        scopeSubscriptions: [],
      },
      sendText: (frame: string) => frames.push(frame),
      close: () => {},
    },
    frames,
  };
}

export interface TaskMessageFanoutFixture {
  /** Frames the workspace-wide branch delivered, one per message. */
  workspaceFrames: string[];
  /** Frames the Chat-scoped branch delivered. */
  chatFrames: string[];
  /** Frames a member with no access to the private task received (always empty). */
  deniedFrames: string[];
}

/**
 * Pin id generation and the clock so two runs of the same fixture emit
 * byte-comparable frames. Mirrors `installDeterministicIds`.
 */
export function installDeterministicFanoutClock(): () => void {
  const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const RealDate = globalThis.Date;
  let clock = Date.UTC(2026, 8, 27, 12, 0, 0);
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock++);
      else super(...(args as []));
    }
    static now(): number {
      return clock++;
    }
  }
  (globalThis as { Date: unknown }).Date = FixtureDate;
  let state = 0x474_5ce1;
  const nextByte = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 24) & 0xff;
  };
  (globalThis.crypto as { getRandomValues: unknown }).getRandomValues =
    (array: ArrayLike<number> & { length: number }) => {
      for (let index = 0; index < array.length; index += 1) {
        (array as unknown as number[])[index] = nextByte();
      }
      return array;
    };
  return () => {
    (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = realGetRandomValues;
    (globalThis as { Date: unknown }).Date = RealDate;
  };
}

/** Build the store the fixture runs against. Caller owns `db`. */
export function fanoutFixtureStore(db: Database): MultiremiStore {
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  return store;
}

/**
 * Drive both fan-out branches and return the frames.
 *
 * The caller supplies the notifier so the same fixture can run against the
 * pre-change and post-change signatures: on the pre-change commit it is handed a
 * whole Task, after the change a `TaskMessageFanoutSubject`. The two objects in
 * this fixture are built by the store in both cases, so the comparison is about
 * what the fan-out emits, not about how the subject was produced.
 */
export type FanoutNotifier = (
  store: MultiremiStore,
  workspaceRegistry: BrowserWebSocketRegistry,
  scopeRegistry: BrowserScopeWebSocketRegistry,
  task: Parameters<typeof import("@multiremi/api/realtime.js").notifyBrowserTaskMessages>[3],
  messages: ReturnType<MultiremiStore["appendTaskMessages"]>,
) => void;

export function driveTaskMessageFanout(
  store: MultiremiStore,
  notify: FanoutNotifier,
): TaskMessageFanoutFixture {
  // Branch 1: a workspace task with a private-ish Agent, so the visibility filter
  // is part of what is being measured. The owner sees the frames; a plain member
  // must not, which is why the fan-out resolves the Agent at all.
  store.createWorkspaceMember({ workspaceId: "local", userId: "member", name: "Member", role: "member" });
  const agent = store.createAgent({
    id: "agt_fanout",
    name: "Fanout Bot",
    provider: "claude",
    workspaceId: "local",
  });
  const task = store.createTask({
    id: FANOUT_WORKSPACE_TASK_ID,
    agentId: agent.id,
    workspaceId: "local",
    prompt: "p".repeat(4_096),
  });
  const messages = store.appendTaskMessages(task.id, [
    { seq: 1, type: "text", content: "hello" },
    { seq: 2, type: "tool_use", tool: "Bash", input: { command: "ls" }, toolCallId: "tc_1", status: "in_progress" },
    { seq: 3, type: "tool_result", tool: "Bash", output: "ok", toolCallId: "tc_1", status: "completed", meta: { duration_ms: 42 } },
  ]);

  const owner = fanoutBrowserClient("local");
  const denied = fanoutBrowserClient("member");
  const workspaceRegistry: BrowserWebSocketRegistry = new Map([
    ["local", new Set([owner.client, denied.client])],
  ]);
  notify(store, workspaceRegistry, new Map(), task, messages);

  // Branch 2: a Chat transport task, which routes to the scope registry instead.
  const chat = store.createChatSession({ id: FANOUT_CHAT_SESSION_ID, agentId: agent.id, creatorId: "local" });
  const chatTask = store.createTask({
    id: FANOUT_CHAT_TASK_ID,
    agentId: agent.id,
    workspaceId: "local",
    chatSessionId: chat.id,
    prompt: "q".repeat(4_096),
  });
  const chatMessages = store.appendTaskMessages(chatTask.id, [
    { seq: 1, type: "text", content: "chat hello" },
  ]);
  const scoped = fanoutBrowserClient("local");
  const scopeRegistry: BrowserScopeWebSocketRegistry = new Map([
    [`chat\u0000${FANOUT_CHAT_SESSION_ID}`, new Set([scoped.client])],
    [`task\u0000${FANOUT_CHAT_TASK_ID}`, new Set([scoped.client])],
  ]);
  notify(store, new Map(), scopeRegistry, chatTask, chatMessages);

  return {
    workspaceFrames: owner.frames,
    chatFrames: scoped.frames,
    deniedFrames: denied.frames,
  };
}
