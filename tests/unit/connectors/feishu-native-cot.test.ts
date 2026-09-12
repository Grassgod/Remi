import { describe, expect, it } from "bun:test";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { cotTextEvents, FeishuCotTransport } from "@connectors/feishu/native-cot.js";
import { completed, nativeHarness, taskEvent, transcript } from "./feishu-native-harness.js";
import type { FeishuPresentationCheckpoint } from "@multiremi/contracts/types.js";

const meta = { taskId: "tsk_test", displayName: "Remi", respondHumanRequest: async () => { throw new Error("Unexpected interaction"); } };
function renderer(h: ReturnType<typeof nativeHarness>, extra: Record<string, unknown> = {}) {
  return new FeishuTaskPresentation(h.client as any, "oc_group", meta, {
    appId: "cli_test", replyToMessageId: "om_root", mentionOpenId: "ou_user", idempotencyKey: "delivery",
    checkpoint: h.checkpoint, save: h.save, ...extra,
  });
}

describe("native CoT Task presentation", () => {
  it("interrupts an unresponsive native API call on handover without sending a result from the old lease", async () => {
    const h = nativeHarness();
    let started = false;
    h.client.request = async () => { started = true; return new Promise(() => {}); };
    const controller = new AbortController();
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_chat", { ...meta, signal: controller.signal },
      { appId: "cli_test", idempotencyKey: "delivery", save: h.save });
    const running = presentation.consume(transcript());
    while (!started) await Bun.sleep(1);
    controller.abort(new Error("handover"));
    await expect(running).rejects.toThrow("handover");
    expect(h.checkpoint?.cot?.status).toBe("creating");
    expect(h.cards()).toHaveLength(0);
  });
  it("streams consecutive process deltas into one native message and uses Task elapsed time", async () => {
    const h = nativeHarness();
    async function* chunks() {
      yield taskEvent(1, "thinking", { content: "First " });
      yield taskEvent(2, "thinking", { content: "thought" });
      yield taskEvent(3, "text", { content: "final", meta: { phase: "final" } });
      yield { ...completed, snapshot: { ...(completed as any).snapshot, startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:46Z" } } as typeof completed;
    }
    await renderer(h).consume(chunks());
    const events = h.events();
    expect(events.filter(e => e.event_type === "REASONING_MESSAGE_START")).toHaveLength(1);
    expect(events.filter(e => e.event_type === "REASONING_MESSAGE_END")).toHaveLength(1);
    const content = events.filter(e => e.event_type === "REASONING_MESSAGE_CONTENT").map(e => JSON.parse(e.content));
    expect(new Set(content.map(c => c.messageId)).size).toBe(1);
    expect(content.map(c => c.delta).join("")).toBe("First thought");
    expect(JSON.stringify(h.cards())).toContain("46s");
  });
  it("uses the native endpoint and origin message, then sends only the final answer as a card", async () => {
    const h = nativeHarness();
    await renderer(h).consume(transcript());
    expect(h.calls[0]).toMatchObject({ operation: "POST", input: { url: "/open-apis/im/v1/message_cot",
      params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_group", origin_message_id: "om_root" } } });
    const events = h.events();
    expect(events[0].event_type).toBe("RUN_STARTED");
    expect(events.at(-1).event_type).toBe("RUN_FINISHED");
    expect(events.filter(e => e.event_type === "TOOL_CALL_START")).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("I will inspect");
    expect(JSON.stringify(events)).toContain("source.ts");
    expect(JSON.stringify(events)).not.toContain("Final answer");
    expect(JSON.stringify(events)).not.toContain("<at ");
    expect(h.cards()).toHaveLength(1);
    const final = JSON.stringify(h.cards()[0]);
    expect(final).toContain("Final answer");
    expect(final).not.toContain("I will inspect");
    expect(final).not.toContain("Show 1 steps");
    expect(final).toContain("Remi Claude fable51");
    expect(final).toContain("82k/1M");
    expect(final).toContain("<at id=ou_user></at>");
    expect(h.checkpoint?.cot?.status).toBe("finished");
    expect(h.checkpoint?.resultMessageId).toBe("om_1");
  });

  it("a direct answer creates no process message or placeholder", async () => {
    const h = nativeHarness();
    async function* simple() { yield taskEvent(1, "text", { content: "Hello" }); yield completed; }
    await renderer(h).consume(simple());
    expect(h.calls.map(c => c.operation)).toEqual(["reply"]);
    expect(JSON.stringify(h.cards())).toContain("Hello");
    expect(JSON.stringify(h.cards())).not.toContain("过程已完成");
  });

  for (const status of ["failed", "cancelled"] as const) it(`ends a ${status} run through the appropriate native lifecycle`, async () => {
    const h = nativeHarness();
    async function* stream() {
      yield taskEvent(1, "thinking", { content: "正在检查。" });
      yield { kind: "snapshot", snapshot: { ...(completed as any).snapshot, status, error: "example failure" } } as typeof completed;
    }
    await renderer(h).consume(stream());
    const completes = h.calls.filter(c => c.input.url?.includes("/complete/"));
    if (status === "failed") {
      expect(h.events().at(-1)?.event_type).toBe("RUN_ERROR");
      expect(completes).toHaveLength(1);
      expect(completes[0]?.input).toMatchObject({ method: "POST", url: "/open-apis/im/v1/message_cot/complete/cot_1", params: { message_id: "om_cot", reason: "error" } });
    } else {
      expect(JSON.parse(h.events().at(-1)!.content).status).toBe("interrupted");
      expect(completes).toHaveLength(0);
    }
    expect(h.checkpoint?.cot?.status).toBe("finished");
    expect(h.cards()).toHaveLength(1);
  });

  it("finishes the result even when explicit native completion is permanently rejected", async () => {
    const h = nativeHarness(), original = h.client.request;
    h.client.request = async input => {
      if (input.url.includes("/complete/")) { h.calls.push({ operation: input.method, input }); return { code: 230001, data: {} }; }
      return original(input);
    };
    async function* stream() {
      yield taskEvent(1, "thinking", { content: "检查。" });
      yield { kind: "snapshot", snapshot: { ...(completed as any).snapshot, status: "failed", error: "failure" } } as typeof completed;
    }
    await renderer(h).consume(stream());
    expect(h.calls.filter(c => c.input.url?.includes("/complete/"))).toHaveLength(1);
    expect(h.checkpoint?.cot?.status).toBe("disabled");
    expect(h.cards()).toHaveLength(1);
  });

  it("closes an older renderer's active display on upgrade without mixing event IDs or losing the answer", async () => {
    const h = nativeHarness();
    await renderer(h, { checkpoint: { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 4, interactions: {},
      cot: { status: "active", cotId: "old", messageId: "old_message", runStarted: true } } }).consume(transcript());
    expect(h.calls.filter(c => c.input.url?.includes("/complete/"))).toHaveLength(1);
    expect(h.events()).toHaveLength(0);
    expect(h.cards()).toHaveLength(1);
    expect(h.checkpoint?.cot?.error).toBe("legacy_cot_closed_on_upgrade");
  });

  it("preserves explicit text phases and excludes subagent text from the final answer", async () => {
    const h = nativeHarness();
    async function* phases() {
      yield taskEvent(1, "text", { content: "progress", meta: { phase: "commentary" } });
      yield taskEvent(2, "text", { content: "child", meta: { parent_tool_call_id: "tc_child" } });
      yield taskEvent(3, "text", { content: "final", meta: { phase: "final" } });
      yield completed;
    }
    await renderer(h).consume(phases());
    expect(JSON.stringify(h.events())).toContain("progress");
    expect(JSON.stringify(h.events())).not.toContain("child");
    expect(JSON.stringify(h.cards())).not.toContain("progress");
    expect(JSON.stringify(h.cards())).not.toContain("child");
    expect(JSON.stringify(h.cards())).toContain("final");
  });

  it("does not replay acknowledged native events after a daemon restart", async () => {
    const h = nativeHarness();
    async function* interrupted() {
      yield taskEvent(1, "tool_use", { tool: "Read", toolCallId: "tc", input: { file_path: "/source.ts" } });
      while (!h.checkpoint?.throughSeq) await Bun.sleep(5);
      throw new Error("disconnect");
    }
    await expect(renderer(h).consume(interrupted())).rejects.toThrow("disconnect");
    expect(h.checkpoint?.throughSeq).toBe(1);
    async function* resumed() {
      yield taskEvent(1, "tool_use", { tool: "Read", toolCallId: "tc", input: { file_path: "/source.ts" } });
      yield taskEvent(2, "tool_result", { toolCallId: "tc", output: "result" });
      yield taskEvent(3, "text", { content: "Done" }); yield completed;
    }
    await renderer(h).consume(resumed());
    expect(h.calls.filter(c => c.operation === "POST")).toHaveLength(1);
    expect(h.events().filter(e => e.event_type === "TOOL_CALL_START")).toHaveLength(1);
    expect(h.events().filter(e => e.event_type === "TOOL_CALL_RESULT")).toHaveLength(0);
  });

  for (const cot of [{ status: "creating" }, { status: "active", cotId: "cot_1", messageId: "om_cot", writePending: true }]) {
    it(`stops an ambiguous ${cot.status} operation and still delivers the result`, async () => {
      const h = nativeHarness();
      await renderer(h, { checkpoint: { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: {}, cot } }).consume(transcript());
      expect(h.calls.some(c => ["POST", "PUT"].includes(c.operation))).toBe(false);
      expect(h.cards()).toHaveLength(1);
      expect(h.checkpoint?.cot?.error).toBe("unconfirmed_native_write");
    });
  }

  it("records a create intent before any send and stops when the checkpoint fails", async () => {
    const h = nativeHarness();
    await expect(renderer(h, { save: async () => { throw new Error("stale lease"); } }).consume(transcript())).rejects.toThrow("stale lease");
    expect(h.calls).toHaveLength(0);
  });

  it("has no replay gap between native append acknowledgement and cursor checkpoint", async () => {
    const h = nativeHarness();
    let persisted: FeishuPresentationCheckpoint | undefined;
    await expect(renderer(h, { save: async (state: FeishuPresentationCheckpoint) => {
      if (state.throughSeq > 0) throw new Error("ack lost");
      persisted = structuredClone(state);
    } }).consume(transcript())).rejects.toThrow("ack lost");
    expect(persisted?.cot?.writePending).toBe(true);
    const initialWrites = h.events().length;
    await renderer(h, { checkpoint: persisted }).consume(transcript());
    expect(h.events()).toHaveLength(initialWrites);
    expect(h.cards()).toHaveLength(1);
  });

  it("uses a stable result UUID when send succeeded but the result checkpoint failed", async () => {
    const h = nativeHarness();
    await expect(renderer(h, { save: async (state: FeishuPresentationCheckpoint) => {
      if (state.resultMessageId) throw new Error("ack lost");
      await h.save(state);
    } }).consume(transcript())).rejects.toThrow("ack lost");
    await renderer(h).consume(transcript());
    expect(h.uuids.size).toBe(1);
    const sends = h.calls.filter(c => c.operation === "reply");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.input.data.uuid).toBe(sends[1]!.input.data.uuid);
  });

  it("does not retry permanent CoT rejection and does not swallow the final answer", async () => {
    const h = nativeHarness();
    h.client.request = async input => { h.calls.push({ operation: input.method, input }); return { code: 230028, data: {} }; };
    await renderer(h).consume(transcript());
    expect(h.calls.filter(c => c.operation === "POST")).toHaveLength(1);
    expect(h.checkpoint?.cot?.status).toBe("disabled");
    expect(h.cards()).toHaveLength(1);
  });

  it("a permanent final-card refusal is propagated without retry loops", async () => {
    const h = nativeHarness();
    let attempts = 0;
    h.client.im.message.reply = async () => { attempts++; return { code: 230028, data: { message_id: "" } }; };
    await expect(renderer(h).consume(transcript())).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });

  it("splits Unicode/escaped text and rejects oversized native batches locally", async () => {
    const h = nativeHarness();
    const text = '中文🙂"\\\n'.repeat(5000);
    const samples = cotTextEvents("reason", text, true);
    expect(samples.filter(([t]) => t.endsWith("CONTENT")).map(([, c]) => c.delta).join("")).toBe(text);
    expect(samples.every(([, c]) => Buffer.byteLength(JSON.stringify(c)) <= 4096)).toBe(true);
    const cot = new FeishuCotTransport(h.client as any);
    await expect(cot.write({ cotId: "c", messageId: "m" }, Array(51).fill({ event_type: "RUN_STARTED", content: "{}", timestamp: "1" }))).rejects.toThrow("1–50");
    expect(h.calls).toHaveLength(0);
  });
});
