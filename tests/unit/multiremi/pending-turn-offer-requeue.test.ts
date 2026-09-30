import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers } from "@multiremi/api/daemon-protocol/task-offers.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("pending turn offer rescind", (fixture) => {
  for (const kind of ["issue", "chat"] as const) {
    it(`rescinds an archived ${kind} lane without business validation or a terminal report`, () => {
      const { store, db } = fixture();
      const runtime = store.registerRuntime({ name: "Archived offer", provider: "codex" });
      const agent = store.createAgent({ name: "Archived owner", provider: "codex", runtimeId: runtime.id });
      const issue = store.createIssue({ title: "Archived lane", status: "in_progress" });
      const session = kind === "issue" ? store.getOrCreateDefaultIssueSession(issue.id)
        : store.createChatSession({ agentId: agent.id });
      const input = { agentId: agent.id, wakeSource: "inbox",
        ...(kind === "issue" ? { issueId: issue.id, issueSessionId: session.id } : { chatSessionId: session.id }) };
      const first = store.createTask({ ...input, prompt: "First wake" });
      expect(store.claimTask(runtime.id)?.id).toBe(first.id);
      const second = store.createTask({ ...input, prompt: "Second wake" });
      db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);
      if (kind === "chat") db.run("UPDATE multiremi_chat_sessions SET status = 'archived' WHERE id = ?", [session.id]);
      const status = store.getIssue(issue.id)!.status;
      expect(store.requeueTaskOffer(first.id, runtime.id)).toBe(true);
      expect(store.getTask(first.id)?.status).toBe("cancelled");
      expect(store.getTask(second.id)?.status).toBe("queued");
      expect(store.getIssue(issue.id)?.status).toBe(status);
    });
    it(`keeps a human ${kind} offer outside the partial index when a platform turn is queued`, () => {
      const { store } = fixture();
      const runtime = store.registerRuntime({ name: "Human offer", provider: "codex" });
      const agent = store.createAgent({ name: "Human owner", provider: "codex", runtimeId: runtime.id });
      const issue = store.createIssue({ title: "Human queue", status: "in_progress" });
      const session = kind === "issue" ? store.getOrCreateDefaultIssueSession(issue.id)
        : store.createChatSession({ agentId: agent.id });
      const input = { agentId: agent.id,
        ...(kind === "issue" ? { issueId: issue.id, issueSessionId: session.id } : { chatSessionId: session.id }) };
      const human = store.createTask({ ...input, prompt: "Human context" });
      expect(store.claimTask(runtime.id)?.id).toBe(human.id);
      const platform = store.createTask({ ...input, prompt: "Platform context", wakeSource: "inbox" });
      expect(store.requeueTaskOffer(human.id, runtime.id)).toBe(true);
      expect(store.getTask(human.id)).toMatchObject({ status: "queued", prompt: "Human context" });
      expect(store.getTask(platform.id)).toMatchObject({ status: "queued", prompt: "Platform context" });
    });
    for (const firstIsNewer of [false, true]) {
      it(`rescind preserves the queued ${kind} turn and both inbox wakes (${firstIsNewer ? "T1" : "T2"} has the larger wake_seq)`, async () => {
        const { store, db } = fixture();
        const runtime = store.registerRuntime({ id: "rt_requeue", name: "Offer runtime", provider: "codex",
          daemonId: "dmn_requeue", status: "online", maxConcurrency: 1, metadata: { parallel_agent_execution: 1 } });
        const agent = store.createAgent({ name: "Offer owner", provider: "codex", runtimeId: runtime.id });
        const delegator = store.createAgent({ name: "Delegator", provider: "codex" });
        const issue = store.createIssue({ title: "Coalesced offer", status: "in_progress" });
        const session = kind === "issue" ? store.getOrCreateDefaultIssueSession(issue.id)
          : store.createChatSession({ agentId: agent.id });
        const input = { agentId: agent.id, wakeSource: "delegation_return",
          ...(kind === "issue" ? { issueId: issue.id, issueSessionId: session.id,
            delegationId: "dlg_requeue", delegatedByAgentId: delegator.id } : { chatSessionId: session.id }) };
        const first = store.createTask({ ...input, prompt: "T1 immutable context" });
        const to = kind === "issue" ? { role: "agent" as const, agentId: agent.id, issueSessionId: session.id }
          : { role: "chat" as const, agentId: agent.id, chatSessionId: session.id };
        const entry = (body: string, taskId: string) => store.appendConversationLog({
          sessionId: session.id, kind: "system", authorType: "system", bodyMd: body,
          metadata: { envelope: { to, kind: "report", wake: "now", priority: 3, source: { taskId } } },
        });
        const e1 = entry("T1 inbox reason", first.id);
        db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [e1.seq, first.id]);
        const connect = async (owner: MultiremiStore) => {
          const layer = new DaemonProtocolLayer({ store: owner });
          const clock = new ManualDaemonProtocolClock(Date.now());
          new DaemonTaskOffers({ store: owner, layer, clock, prepare: async task => daemonTaskClaimResponse(owner, task) });
          const frames: Array<{ t: string; p: { id?: string } }> = [];
          const socket = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
            { accessToken: null, masterToken: true });
          await socket.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2,
            cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: "dmn_requeue", caps: ["offer"],
            runtimes: [{ runtime_id: runtime.id, provider: "codex", max_concurrency: 1, active_task_ids: [] }] } }));
          await layer.drain();
          return { layer, frames };
        };
        const initial = await connect(store);
        let restarted: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          expect(initial.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.id)).toEqual([first.id]);
          const second = store.createTask({ ...input, prompt: "T2 immutable context" });
          const e2 = entry("T2 inbox reason", second.id);
          const firstSeq = firstIsNewer ? e2.seq : e1.seq;
          const secondSeq = firstIsNewer ? e1.seq : e2.seq;
          db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [firstSeq, first.id]);
          db.run("UPDATE multiremi_tasks SET wake_seq = ? WHERE id = ?", [secondSeq, second.id]);
          const status = store.getIssue(issue.id)!.status;
          const frozenContext = store.getTask(second.id)!;
          initial.layer.closeAll(); initial.layer.stop(); await initial.layer.drain();
          expect(db.query("SELECT id, wake_seq FROM multiremi_tasks WHERE status = 'queued' AND agent_id = ?").all(agent.id))
            .toEqual([{ id: second.id, wake_seq: Math.max(firstSeq, secondSeq) }]);
          expect(store.getTask(first.id)?.status).toBe("cancelled");
          if (kind === "issue") expect(store.findTurnEntry(first.id)?.metadata.status).toBe("cancelled");
          else expect(store.findTurnEntry(first.id)).toBeNull();
          expect(store.getTask(second.id)).toMatchObject({ prompt: frozenContext.prompt,
            triggerCommentId: frozenContext.triggerCommentId, execution_scope: frozenContext.execution_scope });
          const auditTable = kind === "issue" ? "multiremi_issue_activity" : "multiremi_system_events";
          const auditType = kind === "issue" ? "type" : "event";
          expect(db.query(`SELECT id FROM ${auditTable} WHERE ${auditType} = 'pending_turn_skipped'`).all()).toHaveLength(1);
          expect(db.query(`SELECT id FROM ${auditTable} WHERE ${auditType} = 'pending_turn_coalesced'`).all()).toHaveLength(1);
          expect(store.getIssue(issue.id)!.status).toBe(status);
          const cursor = kind === "issue" ? store.getSessionAgentLane(session.id, agent.id, first.execution_scope)?.cursorSeq ?? 0 : 0;
          expect(store.listConversationLogEntries(session.id, { sinceSeq: cursor }).filter(row => row.metadata.envelope)
            .map(row => row.body_md)).toEqual(["T1 inbox reason", "T2 inbox reason"]);
          expect(store.listConversationLogEntries(session.id).filter(row => row.kind === "delegation_report")).toEqual([]);
          expect(store.listTasks().filter(task => task.delegationReturnTaskId)).toEqual([]);
          restarted = await connect(new MultiremiStore(db));
          expect(restarted.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.id)).toEqual([second.id]);
        } finally {
          initial.layer.closeAll(); initial.layer.stop(); await initial.layer.drain();
          restarted?.layer.closeAll(); restarted?.layer.stop(); await restarted?.layer.drain();
        }
      }, 30_000);
    }
  }
});
