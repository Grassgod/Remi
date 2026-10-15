import { describe, expect, it } from "bun:test";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { cotTextEvents, FeishuCotTransport } from "@connectors/feishu/native-cot.js";
import { singleMessageStream } from "../../../apps/remi/cli/multiremi.js";
import { agentMessage, command, completed, delta, item, nativeHarness, read, reasoning, snapshot, started, streamedText, terminal,
  transcript, turnCompleted, turnStarted, turnUpdated, updated } from "./feishu-native-harness.js";
import type { FeishuPresentationCheckpoint } from "@multiremi/contracts/types.js";
import type { TaskStreamEvent } from "@connectors/base.js";

const meta = { taskId: "tsk_test", displayName: "Remi" };
function renderer(h: ReturnType<typeof nativeHarness>, extra: Record<string, unknown> = {}) {
  return new FeishuTaskPresentation(h.client as any, "oc_group", meta, {
    appId: "cli_test", replyToMessageId: "om_root", mentionOpenId: "ou_user", idempotencyKey: "delivery",
    checkpoint: h.checkpoint, save: h.save, ...extra,
  });
}

describe("native CoT Task presentation", () => {
  it.each([["final", undefined], ["final", true], ["unknown", undefined], ["unknown", true]] as const)(
    "restores a checkpointed %s answer with waitingFinished=%s without repeating process or request cards", async (phase, waitingFinished) => {
    const h = nativeHarness();
    const permission = item("permission", "perm:approved", { message_id: "approved", title: "Read", outcome: "selected" });
    const question = item("question", "q:answered", { message_id: "answered", message: "Which file?" });
    const answer = agentMessage("msg:answer", "Exact final answer.", phase);
    const prefix = [
      turnStarted(1),
      completed(2, agentMessage("msg:intro", "Checking now.", "commentary")),
      started(3, read("toolu_read", "/source.ts")),
      completed(4, read("toolu_read", "/source.ts")),
      started(5, permission), completed(6, permission),
      started(7, question), completed(8, question),
      started(9, { ...answer, text: "" }),
      delta(10, answer.id, "Exact "),
      turnUpdated(11, { context_usage: { used: 100, size: 200 } }),
      delta(12, answer.id, "final answer."),
    ];
    const settledMeta = { ...meta, getHumanRequest: async (requestId: string) => ({
      id: requestId, taskId: meta.taskId, kind: "question" as const, payload: {}, status: "responded" as const,
      response: {}, respondedBy: "user", createdAt: "2026-10-05T00:00:00Z", respondedAt: "2026-10-05T00:01:00Z",
    }) };
    async function* interrupted() {
      yield* prefix;
      await new Promise(resolve => setTimeout(resolve, 550));
      throw new Error("simulated restart");
    }
    await expect(new FeishuTaskPresentation(h.client as any, "oc_group", settledMeta,
      { appId: "cli_test", idempotencyKey: "delivery", save: h.save }).consume(interrupted()))
      .rejects.toThrow("simulated restart");
    expect(h.checkpoint?.throughSeq).toBe(12);
    const before = h.events().filter(event => !["RUN_STARTED", "RUN_FINISHED"].includes(event.event_type));
    const checkpoint = structuredClone(h.checkpoint!);
    const waiting = waitingFinished ? { waitingStarted: true, waitingFinished } : {};
    checkpoint.interactions = { approved: { messageId: "om_approved", receiptStatus: "responded", ...waiting },
      answered: { messageId: "om_answered", receiptStatus: "responded", ...waiting } };
    let requestReads = 0;
    const final = { ...answer, phase: "final" as const };
    async function* resumed() {
      // The production presentation restart likewise replays from trace seq 0.
      yield* prefix;
      // The daemon settles the reply (the final-reply rule) and closes the turn.
      yield completed(13, final);
      yield turnCompleted(14, [final]);
      yield snapshot({ result: "Wrong fallback with commentary" });
    }
    await new FeishuTaskPresentation(h.client as any, "oc_group", { ...meta, getHumanRequest: async () => {
      requestReads += 1;
      throw new Error("acknowledged request must not be read again");
    } }, { appId: "cli_test", idempotencyKey: "delivery", checkpoint, save: h.save }).consume(resumed());
    expect(requestReads).toBe(0);
    expect(h.events().filter(event => !["RUN_STARTED", "RUN_FINISHED", "REASONING_END"].includes(event.event_type))).toEqual(before);
    expect(h.events().filter(event => event.event_type === "REASONING_END")).toHaveLength(1);
    expect(h.cards()).toHaveLength(1);
    const card = JSON.stringify(h.cards()[0]);
    expect(card).toContain("Exact final answer.");
    expect(card).not.toContain("Checking now.");
    expect(card).not.toContain("Wrong fallback");
  });

  it("writes a tool interrupted by a restart once it completes, without blocking the tools around it", async () => {
    const h = nativeHarness();
    const bash = command("toolu_bash", "git status --short");
    const other = read("toolu_other", "/source.ts");
    const prefix = [turnStarted(1), started(2, { ...bash, command: null, actions: [] }), started(3, other), completed(4, other)];
    async function* interrupted() {
      yield* prefix.slice(0, 2);
      await new Promise(resolve => setTimeout(resolve, 550));
      // A running tool waits for its completion without holding the cursor back.
      expect(h.checkpoint).toMatchObject({ throughSeq: 2 });
      expect(h.events()).toEqual([]);
      yield* prefix.slice(2);
      while (h.checkpoint?.throughSeq !== 4) await Bun.sleep(5);
      throw new Error("simulated restart");
    }
    await expect(new FeishuTaskPresentation(h.client as any, "oc_group", meta,
      { appId: "cli_test", idempotencyKey: "delivery", save: h.save }).consume(interrupted()))
      .rejects.toThrow("simulated restart");
    const checkpoint = structuredClone(h.checkpoint!);
    expect(checkpoint.deferredToolIds).toBeUndefined();
    expect(h.events().filter(event => event.event_type === "TOOL_CALL_START")).toHaveLength(1);
    async function* resumed() {
      yield* prefix;
      yield updated(5, bash);
      yield completed(6, bash);
      yield turnCompleted(7, [bash, other]);
      yield terminal;
    }
    await new FeishuTaskPresentation(h.client as any, "oc_group", meta,
      { appId: "cli_test", idempotencyKey: "delivery", checkpoint, save: h.save }).consume(resumed());
    const starts = h.events().filter(event => event.event_type === "TOOL_CALL_START").map(event => JSON.parse(event.content));
    expect(starts.map(start => start.title)).toEqual(["已读取 source.ts", "已运行 git status --short"]);
    expect(new Set(starts.map(start => start.toolCallId)).size).toBe(2);
    expect(JSON.stringify(h.cards())).toContain("2 tools");
  });

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
      yield started(1, reasoning("rsn:1", ""));
      yield delta(2, "rsn:1", "First ");
      yield delta(3, "rsn:1", "thought");
      yield completed(4, reasoning("rsn:1", "First thought"));
      yield* streamedText(5, agentMessage("msg:final", "final", "final"));
      yield snapshot({ startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:46Z" });
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
  it("creates native CoT in the origin message's thread and sends only the final answer as a card", async () => {
    const h = nativeHarness();
    await renderer(h).consume(transcript());
    expect(h.calls[0]).toMatchObject({ operation: "POST", input: { url: "/open-apis/im/v1/message_cot",
      params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_group", origin_message_id: "om_root", reply_in_thread: true } } });
    expect(h.calls[0]!.input.data).toEqual({ receive_id: "oc_group", origin_message_id: "om_root", reply_in_thread: true });
    const events = h.events();
    expect(events[0].event_type).toBe("RUN_STARTED");
    expect(events.at(-1).event_type).toBe("RUN_FINISHED");
    expect(events.filter(e => e.event_type === "TOOL_CALL_START")).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("I will inspect");
    expect(JSON.stringify(events)).toContain("source.ts");
    expect(JSON.stringify(events)).not.toContain("Final answer");
    expect(JSON.stringify(events)).not.toContain("<at ");
    expect(h.cards()).toHaveLength(1);
    expect(h.calls.find(c => c.operation === "reply")!.input).toMatchObject({
      path: { message_id: "om_root" }, data: { reply_in_thread: true },
    });
    const final = JSON.stringify(h.cards()[0]);
    expect(final).toContain("Final answer");
    expect(final).not.toContain("I will inspect");
    expect(final).not.toContain("Show 1 steps");
    expect(final).toContain("Remi Claude fable51");
    expect(final).toContain("82k/1M");
    expect(final).toContain("1 tools");
    expect(final).toContain("<at id=ou_user></at>");
    expect(h.checkpoint?.cot?.status).toBe("finished");
    expect(h.checkpoint?.resultMessageId).toBe("om_1");
  });

  it("sends private process and result messages to the main chat without creating a topic", async () => {
    const h = nativeHarness();
    await renderer(h, { replyToMessageId: undefined, mentionOpenId: undefined }).consume(transcript());
    const creation = h.calls.find(c => c.operation === "POST")!;
    expect(creation.input.data.receive_id).toBe("oc_group");
    expect(creation.input.data.origin_message_id).toBeUndefined();
    expect(creation.input.data).toEqual({ receive_id: "oc_group" });
    expect(h.calls.filter(c => c.operation === "reply")).toHaveLength(0);
    expect(h.calls.filter(c => c.operation === "create")).toHaveLength(1);
    expect(h.calls.find(c => c.operation === "create")!.input.data.receive_id).toBe("oc_group");
    expect(h.checkpoint?.cot?.status).toBe("finished");
    expect(JSON.stringify(h.cards())).toContain("Final answer");
  });

  it("titles the result card with the Task's provider session, substituting the agent's own name", async () => {
    for (const [agentName, expected] of [["Remi", "自由的 Remi·Sciurus"], ["小助手", "自由的 小助手·Sciurus"]] as const) {
      const h = nativeHarness();
      async function* run() {
        yield turnStarted(1, { agent_name: agentName, provider: "claude" });
        yield turnUpdated(2, { model: "claude-fable-5-1" });
        yield completed(3, agentMessage("msg:answer", "Final answer", "final"));
        yield terminal;
      }
      await new FeishuTaskPresentation(h.client as any, "oc_group", { ...meta, displayName: agentName, sessionId: null },
        { appId: "cli_test", idempotencyKey: "delivery", save: h.save }).consume(run());
      const header = (h.cards()[0] as any).header;
      expect(header.title.content).toStartWith(`${expected}  `);
      // The execution identity stays in the subtitle; the title is session-only.
      expect(header.subtitle.content).toBe(`${agentName} Claude fable51`);
    }
  });

  it("opens as a newborn before the session is known and adopts the session once a snapshot reports it", async () => {
    const h = nativeHarness();
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group",
      { ...meta, sessionId: null }, { appId: "cli_test", idempotencyKey: "delivery", save: h.save });
    expect((presentation as any).sessionId).toBeNull();
    async function* run() {
      yield completed(1, agentMessage("msg:working", "Working", "commentary"));
      yield snapshot({ status: "running", result: null, sessionId: "sess_live" });
      yield completed(2, agentMessage("msg:answer", "Final answer", "final"));
      yield terminal;
    }
    await presentation.consume(run());
    expect((presentation as any).sessionId).toBe("session_original");
    expect((h.cards()[0] as any).header.title.content).toStartWith("自由的 Remi·Sciurus  ");
  });

  it("keeps command replies on the plain agent name because they carry no session or engine", async () => {
    const h = nativeHarness();
    await new FeishuTaskPresentation(h.client as any, "oc_group", { ...meta, taskId: "feishu-command-new", sessionId: undefined },
      { appId: "cli_test", idempotencyKey: "delivery", save: h.save })
      .consume(singleMessageStream("New conversation started.", "feishu-command-new"));
    expect(h.calls.map(call => call.operation)).toEqual(["create"]);
    const card = h.cards()[0] as any;
    expect(card.header.title.content).toStartWith("Remi  ");
    expect(card.header.subtitle.content).toBe("Remi");
    expect(JSON.stringify(card)).toContain("New conversation started.");
  });

  it("omits thread routing without an origin even when the transport caller requests it", async () => {
    const h = nativeHarness();
    const handle = await new FeishuCotTransport(h.client as any).create("oc_private", undefined, true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.input.data).toEqual({ receive_id: "oc_private" });
    expect(handle).toEqual({ cotId: "cot_1", messageId: "om_cot" });
  });

  for (const replyInThread of [undefined, false]) it(`preserves unthreaded transport creation with replyInThread=${replyInThread}`, async () => {
    const h = nativeHarness();
    await new FeishuCotTransport(h.client as any).create("oc_group", "om_origin", replyInThread);
    expect(h.calls[0]!.input.data).toEqual({ receive_id: "oc_group", origin_message_id: "om_origin" });
  });

  it("a direct answer creates no process message or placeholder", async () => {
    const h = nativeHarness();
    async function* simple() {
      yield turnStarted(1);
      yield* streamedText(2, agentMessage("msg:hello", "Hello"));
      yield completed(5, agentMessage("msg:hello", "Hello", "final"));
      yield turnCompleted(6, [agentMessage("msg:hello", "Hello", "final")]);
      yield terminal;
    }
    await renderer(h).consume(simple());
    expect(h.calls.map(c => c.operation)).toEqual(["reply"]);
    expect(JSON.stringify(h.cards())).toContain("Hello");
    expect(JSON.stringify(h.cards())).not.toContain("过程已完成");
  });

  for (const status of ["failed", "cancelled"] as const) it(`ends a ${status} run through the appropriate native lifecycle`, async () => {
    const h = nativeHarness();
    async function* stream() {
      yield completed(1, reasoning("rsn:1", "正在检查。"));
      yield snapshot({ status, error: "example failure" });
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
      yield completed(1, reasoning("rsn:1", "检查。"));
      yield snapshot({ status: "failed", error: "failure" });
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
      yield completed(1, agentMessage("msg:progress", "progress", "commentary"));
      yield completed(2, agentMessage("msg:child", "child", "unknown", { parent_id: "toolu_child" }));
      yield completed(3, agentMessage("msg:final", "final", "final"));
      yield terminal;
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
      yield started(1, read("toolu_read", "/source.ts"));
      yield completed(2, read("toolu_read", "/source.ts", { output: "result" }));
      while (h.checkpoint?.throughSeq !== 2) await Bun.sleep(5);
      throw new Error("disconnect");
    }
    await expect(renderer(h).consume(interrupted())).rejects.toThrow("disconnect");
    expect(h.checkpoint?.throughSeq).toBe(2);
    async function* resumed() {
      yield started(1, read("toolu_read", "/source.ts"));
      yield completed(2, read("toolu_read", "/source.ts", { output: "result" }));
      yield completed(3, agentMessage("msg:done", "Done", "final"));
      yield terminal;
    }
    await renderer(h).consume(resumed());
    expect(h.calls.filter(c => c.operation === "POST")).toHaveLength(1);
    expect(h.events().filter(e => e.event_type === "TOOL_CALL_START")).toHaveLength(1);
    expect(h.events().filter(e => e.event_type === "TOOL_CALL_RESULT")).toHaveLength(0);
  });

  it("closes an active semantic_v1 display over a v1 trace once and answers from the terminal snapshot", async () => {
    const h = nativeHarness();
    const checkpoint: FeishuPresentationCheckpoint = { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 4, interactions: {},
      cot: { status: "active", presentation: "semantic_v1", cotId: "cot_old", messageId: "om_old", runStarted: true } };
    // A Task the fragment-event renderer was presenting: its trace is v1.
    const legacy = (seq: number, type: string, fields: Record<string, unknown>) =>
      ({ kind: "message", message: { seq, ts: "2026-10-01T00:00:00.000Z", type, ...fields } }) as unknown as TaskStreamEvent;
    async function* v1() {
      yield legacy(1, "text", { content: "Checking." });
      yield legacy(2, "tool_use", { tool: "Read", tool_call_id: "tc", input: { file_path: "/a.ts" } });
      yield legacy(5, "tool_result", { tool_call_id: "tc", status: "completed" });
      yield legacy(6, "text", { content: "Legacy answer" });
      yield snapshot({ result: "Legacy answer" });
    }
    await renderer(h, { checkpoint }).consume(v1());
    const completes = h.calls.filter(c => c.input.url?.includes("/complete/"));
    expect(completes.map(c => [c.input.url, c.input.params])).toEqual([
      ["/open-apis/im/v1/message_cot/complete/cot_old", { message_id: "om_old", reason: "timeout" }]]);
    expect(h.calls.filter(c => c.operation === "PUT" || (c.operation === "POST" && c.input.url === "/open-apis/im/v1/message_cot"))).toEqual([]);
    expect(h.checkpoint?.cot).toMatchObject({ status: "disabled", presentation: "semantic_v1", error: "legacy_cot_closed_on_upgrade" });
    expect(h.checkpoint?.throughSeq).toBe(6);
    expect(h.cards()).toHaveLength(1);
    expect(JSON.stringify(h.cards()[0])).toContain("Legacy answer");
    // Resumed again, the closed display is not touched a second time.
    await renderer(h, { checkpoint: h.checkpoint }).consume(v1());
    expect(h.calls.filter(c => c.input.url?.includes("/complete/"))).toHaveLength(1);
  });

  it("tags a new native display with the current renderer", async () => {
    const h = nativeHarness();
    await renderer(h).consume(transcript());
    expect(h.checkpoint?.cot).toMatchObject({ status: "finished", presentation: "items_v1" });
  });

  for (const status of ["completed", "failed"] as const) it(`resumes an active thread CoT handle without recreating it when ${status}`, async () => {
    const h = nativeHarness();
    const checkpoint: FeishuPresentationCheckpoint = {
      version: "native_cot_v1", startedAt: Date.now(), throughSeq: 1, interactions: {},
      cot: { status: "active", presentation: "items_v1", cotId: "cot_saved", messageId: "om_saved", runStarted: true },
    };
    async function* resumed() {
      yield completed(1, reasoning("rsn:1", "Acknowledged process."));
      yield completed(2, reasoning("rsn:2", "Continued process."));
      yield completed(3, agentMessage("msg:answer", "Resumed answer", "final"));
      yield snapshot({ status, error: status === "failed" ? "failure" : null });
    }
    await renderer(h, { checkpoint }).consume(resumed());
    expect(h.calls.filter(c => c.operation === "POST" && c.input.url === "/open-apis/im/v1/message_cot")).toHaveLength(0);
    const writes = h.calls.filter(c => c.operation === "PUT");
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write.input.data).toMatchObject({ cot_id: "cot_saved", message_id: "om_saved" });
    expect(h.events().some(e => e.event_type === "RUN_STARTED")).toBe(false);
    expect(JSON.stringify(h.events())).not.toContain("Acknowledged process.");
    expect(JSON.stringify(h.events())).toContain("Continued process.");
    const completes = h.calls.filter(c => c.input.url?.includes("/complete/"));
    expect(completes).toHaveLength(status === "failed" ? 1 : 0);
    if (status === "failed") expect(completes[0]!.input).toMatchObject({
      method: "POST", url: "/open-apis/im/v1/message_cot/complete/cot_saved",
      params: { message_id: "om_saved", reason: "error" },
    });
    expect(h.cards()).toHaveLength(1);
    expect(h.calls.find(c => c.operation === "reply")!.input).toMatchObject({
      path: { message_id: "om_root" }, data: { reply_in_thread: true },
    });
    expect(JSON.stringify(h.cards())).toContain("Resumed answer");
    expect(h.checkpoint?.cot).toMatchObject({ status: "finished", cotId: "cot_saved", messageId: "om_saved" });
  });

  it("does not recreate a finished thread CoT or resend its checkpointed result", async () => {
    const h = nativeHarness();
    const checkpoint: FeishuPresentationCheckpoint = {
      version: "native_cot_v1", startedAt: Date.now(), throughSeq: 7, interactions: {}, resultMessageId: "om_result",
      cot: { status: "finished", presentation: "items_v1", cotId: "cot_saved", messageId: "om_saved", runStarted: true },
    };
    expect(await renderer(h, { checkpoint }).consume(transcript())).toEqual({ messageId: "om_result" });
    expect(h.calls).toHaveLength(0);
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
