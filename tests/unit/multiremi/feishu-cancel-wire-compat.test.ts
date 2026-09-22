/**
 * Legacy-server compatibility for the Feishu stop endpoint (MUL-358).
 *
 * A daemon upgrades independently of the API it talks to. Before this change
 * the endpoint answered `{ cancelled, task_id }`; newer servers answer a
 * discriminated `outcome`. The client must fall back to the old shape rather
 * than throwing or reporting a stop that never happened, and the card must
 * never render empty text for any combination.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import type { FeishuBotCancelResult } from "@multiremi/contracts/types.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { createFeishuTaskHandler } from "../../../apps/remi/cli/multiremi.js";
import { jsonResponse } from "./helpers.js";

/**
 * Stub `fetch` for exactly one test.
 *
 * `helpers.mockFetch` remembers the implementation it replaced, so calling it
 * twice in one test buries the real `fetch` beneath a previous stub and leaks a
 * canned response into every later test file. Here the replacement is installed
 * once per test and torn down explicitly, and the recording test swaps a
 * handler rather than installing a second stub.
 */
let currentBody: unknown = {};
let handler: ((url: string, init?: RequestInit) => Response) | null = null;
let realFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler ? handler(String(input), init) : jsonResponse(currentBody)) as typeof globalThis.fetch;
});

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  handler = null;
  currentBody = {};
});

const PATH = "/api/daemon/runtimes/rt_bot/feishu-bot/session/cancel";

function clientReturning(body: unknown): MultiremiDaemonClient {
  currentBody = body;
  return new MultiremiDaemonClient("https://remi.example", "tok_test");
}

/**
 * Drive a real HTTP response body through the real client and the real command
 * handler, and return the reply card the user would see. This is the whole
 * path a daemon takes, so a wire change cannot silently produce an empty card.
 * Each call swaps the body the single per-test stub returns.
 */
async function renderStopCard(body: unknown): Promise<string> {
  currentBody = body;
  const client = new MultiremiDaemonClient("https://remi.example", "tok_test");
  const daemon = {
    cancelFeishuBotSessionTask: (
      revision: number, sessionKey: string,
      options?: { chatId?: string | null; senderOpenId?: string | null; target?: string | null },
    ) => client.cancelFeishuBotSessionTask("rt_bot", revision, sessionKey, options),
  } as unknown as MultiremiDaemon;
  const text: string[] = [];
  await createFeishuTaskHandler(daemon, 4, "Concierge")(
    {
      chatId: "oc_group",
      text: "贺华杰: /stop",
      metadata: { messageId: "om_click", chatType: "group", senderOpenId: "ou_owner", rawContent: "/stop" },
    },
    "oc_group:thread:omt_click",
    async (stream) => {
      for await (const event of stream as AsyncIterable<TaskStreamEvent>) {
        if (event.kind === "message" && event.message.content) text.push(event.message.content);
      }
    },
  );
  return text.join("\n");
}

describe("Feishu cancel wire compatibility", () => {
  it("falls back to `cancelled` when the server sends no outcome", async () => {
    const client = clientReturning({ cancelled: true, task_id: "tsk_old" });
    const result = await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
    expect(result).toMatchObject({ outcome: "cancelled", taskId: "tsk_old" });
  });

  it("reports none when an old server cancels nothing", async () => {
    const client = clientReturning({ cancelled: false, task_id: null });
    const result = await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
    expect(result).toMatchObject({ outcome: "none", taskId: null });
  });

  it("keeps a discriminated outcome when the server sends one", async () => {
    const client = clientReturning({
      outcome: "ambiguous",
      candidates: [{ task_id: "tsk_a", status: "running", started_at: "2026-09-21T15:00:00.000Z" }],
      candidate_count: 2,
    });
    const result = await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
    expect(result).toMatchObject({ outcome: "ambiguous", candidateCount: 2 });
    expect(result.candidates.map((candidate) => candidate.taskId)).toEqual(["tsk_a"]);
  });

  it("drops an unrecognised free-text reason instead of forwarding it", async () => {
    // The intermediate server built an English sentence and sent it as `reason`.
    // It must not reach the Chinese card.
    const client = clientReturning({
      outcome: "rejected",
      reason: "MUL-401 is not one of your unfinished tasks in this chat",
    });
    const result = await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toBeNull();
  });

  it("passes through the two known rejection codes", async () => {
    const codes: Array<NonNullable<FeishuBotCancelResult["reason"]>> =
      ["stale_assignment", "target_not_candidate"];
    for (const reason of codes) {
      const client = clientReturning({ outcome: "rejected", reason });
      const result = await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
      expect(result.reason).toBe(reason);
    }
  });

  it("treats an unknown outcome as none rather than guessing a stop", async () => {
    const client = clientReturning({ outcome: "something_new", cancelled: false });
    const result = await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
    expect(result.outcome).toBe("none");
  });

  it("renders a usable card for every legacy and current response shape", async () => {
    // Old server, successful stop.
    expect(await renderStopCard({ cancelled: true, task_id: "tsk_old" }))
      .toBe("已请求停止 Concierge 的任务 tsk_old，CoT 会在数秒内标记为已中断。");
    // Old server, nothing to stop.
    expect(await renderStopCard({ cancelled: false, task_id: null }))
      .toBe("当前没有正在运行的任务。");
    // Intermediate server: rejected with a free-text reason the card must not
    // echo. The fallback sentence is generic, but the card is never empty.
    const intermediate = await renderStopCard({
      outcome: "rejected",
      reason: "MUL-401 is not one of your unfinished tasks in this chat",
    });
    expect(intermediate).toBe("没有停止任何任务：该目标不可用于停止。");
    expect(intermediate).not.toContain("is not one of");
    // Current server with a known code.
    expect(await renderStopCard({ outcome: "rejected", reason: "target_not_candidate" }))
      .toBe("没有停止任何任务：不是你在本群发起的未结束任务。");
    // Unknown outcome from a future server must not claim a stop happened.
    expect(await renderStopCard({ outcome: "something_new", cancelled: false }))
      .toBe("当前没有正在运行的任务。");
  });

  it("never renders an empty card for any response shape", async () => {
    for (const body of [
      { cancelled: true, task_id: "tsk_old" },
      { cancelled: false, task_id: null },
      { outcome: "none" },
      { outcome: "ambiguous", candidates: [], candidate_count: 0 },
      { outcome: "rejected" },
      { outcome: "rejected", reason: "unrecognised free text" },
      {},
    ]) {
      const card = await renderStopCard(body);
      expect(card.length, `empty card for ${JSON.stringify(body)}`).toBeGreaterThan(0);
      expect(card).not.toContain("undefined");
    }
  });

  it("sends the optional disambiguation fields only when present", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    handler = (url, init) => {
      if (url.endsWith(PATH)) bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ outcome: "none" });
    };
    const client = new MultiremiDaemonClient("https://remi.example", "tok_test");
    await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a");
    await client.cancelFeishuBotSessionTask("rt_bot", 4, "oc_a", {
      chatId: "oc_group", senderOpenId: "ou_owner", target: "MUL-401",
    });
    // An old daemon sends neither; an older server must not receive stray keys.
    expect(bodies[0]).toEqual({ revision: 4, external_session_key: "oc_a" });
    expect(bodies[1]).toEqual({
      revision: 4,
      external_session_key: "oc_a",
      chat_id: "oc_group",
      sender_open_id: "ou_owner",
      target: "MUL-401",
    });
  });
});
