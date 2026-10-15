import { readOfferedTurnInput, turnCompletion } from "../fixtures/turn-report.js";
import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { subscribeFeishuTask } from "../../apps/remi/cli/multiremi.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import type { TraceEvent, TraceEventInput } from "@multiremi/contracts/trace.js";
import type { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import { daemonTraceService } from "@multiremi/api/daemon-protocol/trace-handlers.js";
import { DaemonProtocolHarness, waitFor } from "./daemon-protocol-v2/harness.js";
import { input, nativeHarness, read, reasoning, running, turn } from "../unit/connectors/feishu-native-harness.js";

it("presents continuous CoT through a real local daemon/API disconnect, replaying from 0 past its checkpoint", async () => {
  const activeTaskIds: string[] = [];
  let initialReadyDelayed = false;
  const h = await DaemonProtocolHarness.create({
    onReady: daemon => { (daemon as any).claimsPaused = true; },
    beforeSend(frame, socket) {
      if (frame.t === "hello") {
        for (const runtime of frame.p.runtimes) runtime.active_task_ids = [...activeTaskIds];
      } else if (frame.t === "runtime.ready") frame.p.active_task_ids = [...activeTaskIds];
      else return;
      if (frame.t === "runtime.ready" && !initialReadyDelayed) {
        initialReadyDelayed = true;
        // Exercise the real startup race even when the local runner is fast.
        setTimeout(() => { if (!socket.closed) socket.native.send(JSON.stringify(frame)); }, 100);
      } else socket.native.send(JSON.stringify(frame));
      return false;
    },
  });
  const sender = nativeHarness();
  const http: Array<{ method: string; path: string }> = [];
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  let rendering: Promise<{ messageId: string }> | undefined;
  try {
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") http.push({ method: init?.method ?? (input instanceof Request ? input.method : "GET"), path: url.pathname });
      return realFetch(input, init);
    }, { preconnect: realFetch.preconnect });
    await h.startDaemon();
    // Socket connection precedes the server's initial runtime.ready handler.
    // Let its empty active-task snapshot settle before manually claiming a task.
    await waitFor(() => h.ledger.some(entry => entry.type === "runtime.ready"), "initial server runtime readiness");
    const runtimeId = (h.daemon as any).options.runtimeId as string;
    const agent = h.store.createAgent({ name: "MUL-447 local fixture", provider: "claude" });
    const task = h.store.createTask({ agentId: agent.id, prompt: "Synthetic CoT subscription fixture" });
    expect(h.store.claimTask(runtimeId)?.id).toBe(task.id);
    readOfferedTurnInput(h.store, task.id);
    h.store.startTask(task.id);
    // This manually claimed fixture must be advertised as active on reconnect.
    activeTaskIds.push(task.id);
    const transport = (h.daemon as any).ensureTrace() as DaemonTraceTransport;
    const tool = read("toolu_local_read", "/synthetic/source.ts");
    const append = (events: TraceEventInput[]) => transport.append(task.id, runtimeId, events);
    append([{ type: "turn.started", turn: turn({ id: task.id, agent_id: agent.id }) },
      { type: "item.completed", item: input("Synthetic CoT subscription fixture", task.id) },
      { type: "item.completed", item: reasoning("rsn:consumed", "consumed 3") }]);
    await waitFor(() => daemonTraceService(h.layer).sink.head(task.id) === 3, "checkpoint prefix");
    expect(h.store.getTask(task.id)?.status).toBe("running");
    // The prefix through seq 3 was presented before a restart.
    const checkpoint = { version: "native_cot_v1" as const, startedAt: Date.now(), throughSeq: 3, interactions: {},
      cot: { status: "active" as const, presentation: "items_v1" as const, cotId: "cot_existing", messageId: "om_existing", runStarted: true } };
    const received: TraceEvent[] = [];
    async function* stream() {
      // As in production, the presentation replays from seq 0; its checkpoint suppresses the acknowledged prefix.
      for await (const item of subscribeFeishuTask(h.daemon, task.id, controller.signal)) {
        if (item.kind === "message") received.push(item.message);
        yield item;
      }
    }
    rendering = new FeishuTaskPresentation(sender.client as any, "oc_local_fixture", {
      taskId: task.id, signal: controller.signal,
    }, { lane: "cot", appId: "cli_local_fixture", idempotencyKey: "mul447-local", checkpoint, save: sender.save }).consume(stream());
    void rendering.catch(() => {});
    append([
      { type: "item.completed", item: reasoning("rsn:live", "live 4") },
      { type: "item.started", item: running(tool) },
    ]);
    await waitFor(() => received.length === 5 && sender.checkpoint?.throughSeq === 5, "CoT checkpoint before disconnect", 5_000);
    expect(http.filter(request => request.path.endsWith(`/tasks/${task.id}/status`))).toEqual([]);
    await h.disconnect();
    append([
      { type: "item.completed", item: { ...tool, status: "failed", output: "synthetic private stacktrace" } },
      { type: "item.completed", item: reasoning("rsn:recovered", "recovered 7") },
      // A newer producer's event type: carried through unchanged, skipped by the reader.
      { type: "future.widget", content: "literal future payload", input: { nested: [1, { two: true }] } } as unknown as TraceEventInput,
    ]);
    await h.reconnect();
    expect(h.store.getTask(task.id)?.status).toBe("running");
    await waitFor(() => received.length === 8 && sender.checkpoint?.throughSeq === 8, "resumed CoT checkpoint", 5_000);
    // The first subscription replays from 0; the reconnect resumes at the last consumed seq.
    const subscriptions = h.ledger.filter(entry => entry.type === "trace.subscribe");
    expect(subscriptions.map(entry => entry.frame.p.from_seq)).toEqual([0, 5]);
    expect(received.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await h.client.event({ t: "turn.complete", seq: 999_447, rt: runtimeId, p: turnCompletion(h.store, task.id, "Synthetic fixture complete", { ...transport.completion(task.id) }) });
    transport.close(task.id, "completed");
    expect(await rendering).toEqual({ messageId: "om_existing" });
    // Closing appends turn.completed (seq 9) before the trailer.
    expect(received.map(event => event.type).at(-1)).toBe("turn.completed");
    expect(sender.checkpoint).toMatchObject({ throughSeq: 9, cot: { status: "finished" } });
    const nativeEvents = sender.events();
    expect(nativeEvents.filter(event => event.event_type === "REASONING_MESSAGE_CONTENT").map(event => JSON.parse(event.content).delta).join("")).toBe("live 4recovered 7");
    // The replayed prefix through the checkpoint is never sent again.
    expect(JSON.stringify(nativeEvents)).not.toContain("consumed 3");
    const starts = nativeEvents.filter(event => event.event_type === "TOOL_CALL_START");
    const results = nativeEvents.filter(event => event.event_type === "TOOL_CALL_RESULT");
    // Started before the disconnect, completed after it: written once, from its completion.
    expect(starts).toHaveLength(1);
    expect(JSON.parse(starts[0]!.content)).toMatchObject({ title: "已读取 source.ts", icon: "read" });
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]!.content)).toMatchObject({
      toolCallId: JSON.parse(starts[0]!.content).toolCallId,
      content: JSON.stringify({ type: "text", text: "执行失败" }),
    });
    expect(JSON.stringify(nativeEvents)).not.toContain("synthetic private stacktrace");
    expect(received[7]).toMatchObject({ seq: 8, type: "future.widget", content: "literal future payload" });
    expect(nativeEvents.some(event => event.event_type === "future.widget")).toBe(false);
    expect(nativeEvents.at(-1)).toMatchObject({ event_type: "RUN_FINISHED" });
    expect(sender.calls.filter(call => call.operation === "POST")).toEqual([]);
    expect(http.filter(request => request.path.endsWith(`/tasks/${task.id}/messages`))).toEqual([]);
    expect(http.filter(request => request.path.endsWith(`/tasks/${task.id}/status`))).toHaveLength(1);
    expect(http.filter(request => request.path.includes("human-requests"))).toEqual([]);
    expect(h.errors).toEqual([]);
    const evidencePath = process.env.MULTIREMI_TEST_MUL447_EVIDENCE_PATH;
    if (evidencePath) {
      const evidence = { issue: "MUL-447", executed_at: new Date().toISOString(), bun: Bun.version,
        environment: "real local Bun API + real co-resident daemon + temporary SQLite; fake Feishu sender; synthetic trace producer",
        initial_checkpoint: checkpoint.throughSeq, checkpoint_before_disconnect: 5, final_checkpoint: sender.checkpoint?.throughSeq,
        subscribe_from_seq: subscriptions.map(entry => entry.frame.p.from_seq), received_seq: received.map(event => event.seq),
        closed: true, cross_disconnect_tool: { written_on_completion: true, start_count: starts.length, result_count: results.length },
        native_events: nativeEvents, http_requests: http,
        trace_requests: h.ledger.filter(entry => ["trace.subscribe", "trace.fetch", "trace.unsubscribe"].includes(entry.type))
          .map(entry => ({ type: entry.type, task_id: entry.frame.p.task_id, from_seq: entry.frame.p.from_seq, after_seq: entry.frame.p.after_seq })),
        polling: { cot_400ms_removed: true, status_reads: 1, human_750ms_removed: false,
          human_request_note: "No human requests in this CoT fixture. Step 5 deferred: MUL-436 Hub events are API-process local and agent/MUL-421 has no task.human_request.settled producer/receiver." } };
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      const escaped = JSON.stringify(evidence, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      writeFileSync(evidencePath.replace(/\.json$/, ".html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUL-447 local integration evidence</title><style>body{font:15px/1.6 system-ui;margin:24px;max-width:1100px;color:#222}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f3;padding:16px}h1{font-size:24px}p{max-width:900px}</style><h1>MUL-447: local integration evidence</h1><p>Real local daemon/API and temporary SQLite. Feishu sender and trace content are simulated. The presentation replays from 0 past its checkpoint (3), resumes from 5 to 6 after disconnect, and ends on closed. The tool started before the disconnect is written once, from its completion after reconnect. One final status read; no messages polling. Human-request 750 ms polling remains pending its cross-process event transport. Independent QA is still required.</p><pre>${escaped}</pre></html>`);
      console.log(`MUL-447 evidence: ${evidencePath}`);
    }
  } finally {
    controller.abort();
    await rendering?.catch(() => {});
    globalThis.fetch = realFetch;
    await h.dispose();
  }
}, 20_000);
