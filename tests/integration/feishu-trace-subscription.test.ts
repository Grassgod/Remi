import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { subscribeFeishuTask } from "../../apps/remi/cli/multiremi.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import { daemonTraceService } from "@multiremi/api/daemon-protocol/trace-handlers.js";
import { DaemonProtocolHarness, waitFor } from "./daemon-protocol-v2/harness.js";
import { nativeHarness } from "../unit/connectors/feishu-native-harness.js";

it("presents continuous CoT through a real local daemon/API disconnect and resumes at checkpoint + 1", async () => {
  const h = await DaemonProtocolHarness.create({ onReady: daemon => { (daemon as any).claimsPaused = true; } });
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
    const runtimeId = (h.daemon as any).options.runtimeId as string;
    const agent = h.store.createAgent({ name: "MUL-447 local fixture", provider: "claude" });
    const task = h.store.createTask({ agentId: agent.id, prompt: "Synthetic CoT subscription fixture" });
    expect(h.store.claimTask(runtimeId)?.id).toBe(task.id);
    h.store.startTask(task.id);
    const transport = (h.daemon as any).ensureTrace() as DaemonTraceTransport;
    transport.append(task.id, runtimeId, [{ type: "thinking", content: "consumed 1" }, { type: "thinking", content: "consumed 2" }]);
    await waitFor(() => daemonTraceService(h.layer).sink.head(task.id) === 2, "checkpoint prefix");
    const checkpoint = { version: "native_cot_v1" as const, startedAt: Date.now(), throughSeq: 2, interactions: {},
      cot: { status: "active" as const, presentation: "semantic_v1" as const, cotId: "cot_existing", messageId: "om_existing", runStarted: true } };
    const received: TraceEvent[] = [];
    async function* stream() {
      for await (const item of subscribeFeishuTask(h.daemon, task.id, controller.signal, checkpoint.throughSeq)) {
        if (item.kind === "message") received.push(item.message);
        yield item;
      }
    }
    rendering = new FeishuTaskPresentation(sender.client as any, "oc_local_fixture", {
      taskId: task.id, signal: controller.signal, respondHumanRequest: async () => { throw new Error("No human request in this CoT fixture"); },
    }, { lane: "cot", appId: "cli_local_fixture", idempotencyKey: "mul447-local", checkpoint, save: sender.save }).consume(stream());
    void rendering.catch(() => {});
    transport.append(task.id, runtimeId, [
      { type: "thinking", content: "live 3" },
      { type: "tool_use", tool: "Read", toolCallId: "local-read", input: { path: "/synthetic/source.ts" } },
    ]);
    await waitFor(() => received.length === 2 && sender.checkpoint?.throughSeq === 4, "CoT checkpoint before disconnect", 5_000);
    expect(http.filter(request => request.path.endsWith(`/tasks/${task.id}/status`))).toEqual([]);
    await h.disconnect();
    transport.append(task.id, runtimeId, [
      { type: "thinking", content: "recovered 5" },
      { type: "future.widget", content: "literal future payload", input: { nested: [1, { two: true }] }, meta: { arbitrary: "value" } },
    ]);
    await h.reconnect();
    await waitFor(() => received.length === 4 && sender.checkpoint?.throughSeq === 6, "resumed CoT checkpoint", 5_000);
    const subscriptions = h.ledger.filter(entry => entry.type === "trace.subscribe");
    expect(subscriptions.map(entry => entry.frame.p.from_seq)).toEqual([2, 4]);
    expect(received.map(event => event.seq)).toEqual([3, 4, 5, 6]);
    await h.client.event({ t: "task.complete", seq: 999_447, rt: runtimeId, p: {
      task_id: task.id, output: "Synthetic fixture complete", ...transport.completion(task.id),
    } });
    transport.close(task.id, "completed");
    expect(await rendering).toEqual({ messageId: "om_existing" });
    expect(sender.checkpoint).toMatchObject({ throughSeq: 6, cot: { status: "finished" } });
    const nativeEvents = sender.events();
    expect(nativeEvents.filter(event => event.event_type === "REASONING_MESSAGE_CONTENT").map(event => JSON.parse(event.content).delta).join("")).toBe("live 3recovered 5");
    expect(nativeEvents.filter(event => event.event_type === "TOOL_CALL_START")).toHaveLength(1);
    expect(JSON.parse(nativeEvents.find(event => event.event_type === "future.widget")!.content)).toEqual({ ...received[3]! });
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
        initial_checkpoint: checkpoint.throughSeq, checkpoint_before_disconnect: 4, final_checkpoint: sender.checkpoint?.throughSeq,
        subscribe_from_seq: subscriptions.map(entry => entry.frame.p.from_seq), received_seq: received.map(event => event.seq),
        closed: true, native_events: nativeEvents, http_requests: http,
        trace_requests: h.ledger.filter(entry => ["trace.subscribe", "trace.fetch", "trace.unsubscribe"].includes(entry.type))
          .map(entry => ({ type: entry.type, task_id: entry.frame.p.task_id, from_seq: entry.frame.p.from_seq, after_seq: entry.frame.p.after_seq })),
        polling: { cot_400ms_removed: true, status_reads: 1, human_750ms_removed: false,
          human_request_note: "No human requests in this CoT fixture. Step 5 deferred: MUL-436 Hub events are API-process local and agent/MUL-421 has no task.human_request.settled producer/receiver." } };
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      const escaped = JSON.stringify(evidence, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      writeFileSync(evidencePath.replace(/\.json$/, ".html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUL-447 local integration evidence</title><style>body{font:15px/1.6 system-ui;margin:24px;max-width:1100px;color:#222}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f3;padding:16px}h1{font-size:24px}p{max-width:900px}</style><h1>MUL-447: local integration evidence</h1><p>Real local daemon/API and temporary SQLite. Feishu sender and trace content are simulated. CoT resumes from 2 to 3, then from 4 to 5 after disconnect, and ends on closed. One final status read; no messages polling. Human-request 750 ms polling remains pending its cross-process event transport. Independent QA is still required.</p><pre>${escaped}</pre></html>`);
      console.log(`MUL-447 evidence: ${evidencePath}`);
    }
  } finally {
    controller.abort();
    await rendering?.catch(() => {});
    globalThis.fetch = realFetch;
    await h.dispose();
  }
}, 20_000);
