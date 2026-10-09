import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { describe, expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api/server.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { daemonTraceService } from "@multiremi/api/daemon-protocol/trace-handlers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { authenticateBrowserWebSocket } from "../../unit/multiremi/helpers.js";
import { conversationLogPgAdminUrl, withConversationLogStore } from "../../unit/multiremi/fixtures/conversation-log-store.js";
import { waitFor } from "./harness.js";

for (const backend of ["sqlite", "pg"] as const) {
  describe.skipIf(backend === "pg" && !conversationLogPgAdminUrl)(`default trace startup (${backend})`, () => {
    for (const role of ["runtime", "all"] as const) {
      it(`${role}: routes real v2 trace through the default HTTP reader and browser Hub, including close`, async () => {
        await withConversationLogStore(backend, async store => {
          store.ensureLocalWorkspace();
          const runtimeId = "rt_default_trace";
          store.registerRuntime({ id: runtimeId, name: "Trace owner", provider: "codex", daemonId: "dmn_default_trace" });
          store.heartbeatRuntime(runtimeId, {});
          const agent = store.createAgent({ name: "Trace owner", provider: "codex", runtimeId });
          const issue = createResponsibleTestIssue(store, { title: "Default trace" });
          const task = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, { agentId: agent.id, prompt: "Default trace" });
          expect(store.claimTask(runtimeId)?.id).toBe(task.id); store.startTask(task.id);
          let layer!: DaemonProtocolLayer;
          // No reader, sink or Hub injection: exercise production assembly.
          const server = startMultiremiServer({ store, apiRole: role, port: 0, hostname: "127.0.0.1",
            authToken: null, backgroundJobs: false, onDaemonProtocol: value => { layer = value; } });
          const events: TraceEvent[] = [{ seq: 1, type: "text", ts: "2026-10-01T00:00:00Z", content: "Default trace event" }];
          let closed = false;
          const frames: Array<{ t: string; re?: string; p: any }> = [];
          const daemon = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`);
          daemon.onopen = () => daemon.send(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2,
            cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: "dmn_default_trace",
            runtimes: [{ runtime_id: runtimeId, provider: "codex", max_concurrency: 1, active_task_ids: [task.id] }] } }));
          daemon.onmessage = message => {
            const frame = JSON.parse(String(message.data)); frames.push(frame);
            if (frame.t === "trace.read") daemon.send(JSON.stringify({ v: 2, t: "res", re: frame.id,
              p: { ok: true, events, next_after_seq: events.at(-1)!.seq, head: events.at(-1)!.seq, eof: true, closed } }));
            if (frame.seq) daemon.send(JSON.stringify({ v: 2, t: "ack", ack: frame.seq }));
          };
          let browser: WebSocket | undefined;
          let unsubscribe = () => {};
          try {
            await waitFor(() => frames.some(frame => frame.t === "welcome"), "trace daemon hello");
            const token = await store.createAccessToken({ name: "Trace browser", type: "pat", workspaceId: "local" });
            browser = new WebSocket(`ws://127.0.0.1:${server.port}/api/trace/ws?workspace_id=local`);
            await authenticateBrowserWebSocket(browser, token.token);
            const browserFrames: Array<{ type: string; payload: any }> = [];
            browser.onmessage = message => browserFrames.push(JSON.parse(String(message.data)));
            browser.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "trace", id: task.id, from_seq: 0 } }));
            await waitFor(() => browserFrames.some(frame => frame.type === "stream.ack"), "browser trace subscribe");
            const delivered: TraceEvent[] = [];
            const subscription = daemonTraceService(layer).sink.subscribe(task.id, 0, (_id, batch) => delivered.push(...batch));
            unsubscribe = subscription.unsubscribe;
            daemon.send(JSON.stringify({ v: 2, t: "trace.append", id: "append", rt: runtimeId,
              p: { task_id: task.id, events, closed: false } }));
            await waitFor(() => frames.some(frame => frame.re === "append"), "trace append");
            expect(frames.find(frame => frame.re === "append")!.p).toEqual({ ok: true, hub_head: 1 });
            const http = await fetch(`http://127.0.0.1:${server.port}/api/turns/${store.getTurnForAttempt(task.id)!.id}/trace`);
            expect(http.status).toBe(200);
            expect(await http.json()).toMatchObject({ events: [events[0]], head: 1, closed: false });
            await waitFor(() => browserFrames.some(frame => frame.type === "stream.data"), "default browser trace event");
            expect(browserFrames.filter(frame => frame.type === "stream.data").flatMap(frame => frame.payload.frames))
              .toContainEqual(expect.objectContaining({ seq: 1, payload: events[0] }));
            // The real protocol also reads the retained Hub window for CoT and
            // daemon subscribers; this must work with the Hub's flush timing.
            daemon.send(JSON.stringify({ v: 2, t: "trace.subscribe", id: "subscribe", rt: runtimeId,
              p: { task_id: task.id, from_seq: 0 } }));
            await waitFor(() => frames.some(frame => frame.t === "trace.push" && frame.p.events?.length === 1), "retained protocol trace");
            expect(frames.filter(frame => frame.t === "trace.push").flatMap(frame => frame.p.events)).toEqual([events[0]]);
            events.push({ seq: 2, type: "RUN_FINISHED", ts: "2026-10-01T00:00:01Z" }); closed = true;
            daemon.send(JSON.stringify({ v: 2, t: "trace.append", id: "close", rt: runtimeId,
              p: { task_id: task.id, events: [events[1]], closed: true } }));
            await waitFor(() => frames.some(frame => frame.re === "close"), "trace close");
            expect(frames.find(frame => frame.re === "close")!.p).toEqual({ ok: true, hub_head: 2 });
            await waitFor(() => delivered.length === 2, "Live Hub tail");
            expect(delivered).toEqual(events); expect(subscription.closed).toBe(true);
            await waitFor(() => frames.some(frame => frame.t === "trace.push" && frame.p.closed), "protocol trace closed");
            expect(frames.filter(frame => frame.t === "trace.push").flatMap(frame => frame.p.events)).toEqual(events);
            expect(await (await fetch(`http://127.0.0.1:${server.port}/api/turns/${store.getTurnForAttempt(task.id)!.id}/trace`)).json())
              .toMatchObject({ head: 2, closed: true });
          } finally { unsubscribe(); browser?.close(); daemon.close(); server.stop(true); }
        });
      }, 30_000);
    }
  });
}
