import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });

function outbox(h: DaemonProtocolHarness): MultiremiTaskReportOutbox {
  return (h.daemon as any).ensureOutbox();
}

describe("v2 terminal replay after ACK loss", () => {
  for (const recovery of ["socket reconnect", "daemon process restart"] as const) {
    it(`keeps a completed task terminal through ${recovery} and ACKs its persisted outbox row`, async () => {
      let taskId = "";
      let droppedAck = false;
      const roundCards: string[] = [];
      const replySpies: Array<ReturnType<typeof spyOn>> = [];
      const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5],
        onRoundCard: id => roundCards.push(id),
        beforeSend(frame, socket, harness) {
          if (frame.t !== "task.complete" || frame.p.task_id !== taskId || droppedAck) return;
          if (recovery === "daemon process restart") {
            droppedAck = true;
            socket.close(4001);
            return false;
          }
          const session = harness.sessions.at(-1)!;
          const sendReply = session.sendReply.bind(session);
          replySpies.push(spyOn(session, "sendReply").mockImplementation((re, payload) => {
            if (re === String(frame.seq) && (payload as { ok?: unknown }).ok === true && !droppedAck) {
              droppedAck = true;
              socket.close(4001);
              return false;
            }
            return sendReply(re, payload);
          }));
        },
      });
      fixtures.push(h);
      const completeTask = h.store.completeTask.bind(h.store);
      const failTask = spyOn(h.store, "failTask");
      const complete = spyOn(h.store, "completeTask").mockImplementation((id, input) => completeTask(id, input));
      const recover = spyOn(MultiremiDaemonClient.prototype, "recoverOrphans");
      try {
        await h.startDaemon();
        await h.settleHeartbeat();
        const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
        const agent = h.store.createAgent({ name: "ACK loss", provider: "claude", runtimeId, workspaceId: "local" });
        const task = h.store.createTask({ agentId: agent.id, prompt: "complete before ACK loss" });
        taskId = task.id;
        await waitFor(() => droppedAck && h.client.connectionState() === "disconnected"
          && h.store.getTask(taskId)?.status === (recovery === "socket reconnect" ? "completed" : "running"),
          "complete persisted in outbox without ACK", 5_000);
        expect(outbox(h).taskIdsWithPendingTerminal(runtimeId)).toContain(taskId);
        expect(h.ledger.filter(entry => entry.type === "task.complete" && entry.partition === taskId))
          .toHaveLength(recovery === "socket reconnect" ? 1 : 0);
        const recoveryCallsBefore = recover.mock.calls.length;

        if (recovery === "socket reconnect") await h.reconnect();
        else await h.recreateDaemon();
        await waitFor(() => outbox(h).stats().pending === 0 && h.store.getTask(taskId)?.status === "completed",
          "terminal replay ACK and outbox drain", 5_000);
        expect(outbox(h).taskIdsWithPendingTerminal(runtimeId)).not.toContain(taskId);
        expect(h.store.getTask(taskId)).toMatchObject({ status: "completed", result: "fixture", runtimeId });
        expect(complete.mock.calls.filter(([id]) => id === taskId)).toHaveLength(1);
        expect(roundCards.filter(id => id === taskId)).toHaveLength(1);
        expect(h.effectiveLedger.filter(entry => entry.type === "task.complete" && entry.partition === taskId)).toHaveLength(1);
        expect(h.ledger.filter(entry => entry.type === "task.complete" && entry.partition === taskId))
          .toHaveLength(recovery === "socket reconnect" ? 2 : 1);
        expect(failTask.mock.calls.filter(([id]) => id === taskId)).toHaveLength(0);
        expect(h.store.getTask(taskId)?.failureReason).not.toBe("runtime_gone");
        expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.id === taskId)).toHaveLength(1);
        expect(recover.mock.calls).toHaveLength(recoveryCallsBefore);

        // Once the ACK removes the terminal row, the next ready snapshot omits it.
        const ready = (h.daemon as any).protocolLane.runtime();
        h.client.send({ t: "runtime.ready", rt: runtimeId, p: { active_task_ids: ready.active_task_ids } });
        await waitFor(() => h.ledger.some(entry => entry.type === "runtime.ready"
          && entry.frame.p.active_task_ids?.includes(taskId) === false), "post-ACK runtime ready");
      } finally {
        for (const reply of replySpies) reply.mockRestore();
        complete.mockRestore(); failTask.mockRestore(); recover.mockRestore();
      }
    }, 15_000);
  }
});
