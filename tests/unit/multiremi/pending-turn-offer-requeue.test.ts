import { createResponsibleTestIssue } from './helpers.js';
import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers, daemonTurnOfferPayload } from "@multiremi/api/daemon-protocol/task-offers.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("pending turn offer rescind", (fixture) => {
  for (const kind of ["issue", "chat"] as const) {
    it(`requeues an archived ${kind} lane without a terminal report or consuming its requests`, () => {
      const { store, db } = fixture();
      const runtime = store.registerRuntime({ name: "Archived offer", provider: "codex" });
      const agent = store.createAgent({ name: "Archived owner", provider: "codex", runtimeId: runtime.id });
      const issue = createResponsibleTestIssue(store, { title: "Archived lane", status: "in_progress" });
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
      expect(second.id).toBe(first.id);
      expect(store.getTask(first.id)?.status).toBe("queued");
      expect(store.getTask(second.id)?.status).toBe("queued");
      expect(store.getIssue(issue.id)?.status).toBe(status);
      expect(store.claimTask(runtime.id)).toBeNull();
      expect(store.listConversationLogEntries(session.id).filter(row => row.kind === "message").map(row => row.body_md))
        .toEqual(["First wake", "Second wake"]);
      expect(store.getTurnForAttempt(first.id)?.reply_message_id).toBeNull();
    });
    it(`keeps human and platform ${kind} requests in the same pending turn after rescind`, () => {
      const { store } = fixture();
      const runtime = store.registerRuntime({ name: "Human offer", provider: "codex" });
      const agent = store.createAgent({ name: "Human owner", provider: "codex", runtimeId: runtime.id });
      const issue = createResponsibleTestIssue(store, { title: "Human queue", status: "in_progress" });
      const session = kind === "issue" ? store.getOrCreateDefaultIssueSession(issue.id)
        : store.createChatSession({ agentId: agent.id });
      const input = { agentId: agent.id,
        ...(kind === "issue" ? { issueId: issue.id, issueSessionId: session.id } : { chatSessionId: session.id }) };
      const human = store.createTask({ ...input, prompt: "Human context" });
      expect(store.claimTask(runtime.id)?.id).toBe(human.id);
      const platform = store.createTask({ ...input, prompt: "Platform context", wakeSource: "inbox" });
      expect(store.requeueTaskOffer(human.id, runtime.id)).toBe(true);
      expect(store.getTask(human.id)).toMatchObject({ status: "queued", prompt: "Human context" });
      expect(platform.id).toBe(human.id);
      expect(store.listConversationLogEntries(session.id).filter(row => row.kind === "message").map(row => row.body_md))
        .toEqual(["Human context", "Platform context"]);
    });
    for (const firstIsNewer of [false, true]) {
      it(`rescind reoffers every unread ${kind} request in arrival order (${firstIsNewer ? "T2 then T1" : "T1 then T2"})`, async () => {
        const { store, db } = fixture();
        const runtime = store.registerRuntime({ id: "rt_requeue", name: "Offer runtime", provider: "codex",
          daemonId: "dmn_requeue", status: "online", maxConcurrency: 1, metadata: { parallel_agent_execution: 1 } });
        const agent = store.createAgent({ name: "Offer owner", provider: "codex", runtimeId: runtime.id });
        const delegator = store.createAgent({ name: "Delegator", provider: "codex" });
        const issue = createResponsibleTestIssue(store, { title: "Coalesced offer", status: "in_progress" });
        const session = kind === "issue" ? store.getOrCreateDefaultIssueSession(issue.id)
          : store.createChatSession({ agentId: agent.id });
        const input = { agentId: agent.id, wakeSource: "delegation_return",
          ...(kind === "issue" ? { issueId: issue.id, issueSessionId: session.id,
            delegationId: "dlg_requeue", delegatedByAgentId: delegator.id } : { chatSessionId: session.id }) };
        const bodies = firstIsNewer ? ["T2 inbox reason", "T1 inbox reason"] : ["T1 inbox reason", "T2 inbox reason"];
        const first = store.createTask({ ...input, prompt: bodies[0]! });
        const second = store.createTask({ ...input, prompt: bodies[1]! });
        expect(second.id).toBe(first.id);
        const connect = async (owner: MultiremiStore) => {
          const layer = new DaemonProtocolLayer({ store: owner });
          const clock = new ManualDaemonProtocolClock(Date.now());
          new DaemonTaskOffers({ store: owner, layer, clock, prepare: async task =>
            daemonTurnOfferPayload(daemonTaskClaimResponse(owner, task), owner.getDaemonTurnBridge().offerInput(task)) });
          const frames: Array<{ t: string; p: Record<string, any> }> = [];
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
          expect(initial.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.attempt_id)).toEqual([first.id]);
          const status = store.getIssue(issue.id)!.status;
          const frozenContext = store.getTask(first.id)!;
          initial.layer.closeAll(); initial.layer.stop(); await initial.layer.drain();
          expect(db.query("SELECT id FROM multiremi_turn_execution_records WHERE status = 'queued' AND agent_id = ?").all(agent.id))
            .toEqual([{ id: first.id }]);
          expect(store.findTurnEntry(first.id)?.metadata.status).toBe("queued");
          expect(store.getTask(first.id)).toMatchObject({ prompt: frozenContext.prompt,
            triggerCommentId: frozenContext.triggerCommentId, execution_scope: frozenContext.execution_scope });
          const auditTable = kind === "issue" ? "multiremi_issue_activity" : "multiremi_system_events";
          const auditType = kind === "issue" ? "type" : "event";
          expect(db.query(`SELECT id FROM ${auditTable} WHERE ${auditType} = 'wake_downgraded'`).all()).toHaveLength(0);
          expect(store.getIssue(issue.id)!.status).toBe(status);
          const cursor = kind === "issue" ? store.getSessionAgentLane(session.id, agent.id, first.execution_scope)?.cursorSeq ?? 0 : 0;
          expect(store.listConversationLogEntries(session.id, { sinceSeq: cursor }).filter(row => row.kind === "message")
            .map(row => row.body_md)).toEqual(bodies);
          expect(store.listConversationLogEntries(session.id).filter(row => row.kind === "delegation_report")).toEqual([]);
          expect(store.listTasks().filter(task => task.delegationReturnTaskId)).toEqual([]);
          restarted = await connect(new MultiremiStore(db));
          const offers = restarted.frames.filter(frame => frame.t === "task.offer");
          expect(offers.map(frame => frame.p.attempt_id)).toEqual([first.id]);
          const offered = offers[0]!.p.input_messages;
          expect(offered.map((row: any) => store.getMessage(row.id)!.body_md)).toEqual(bodies);
          for (let index = 0; index < bodies.length; index++) expect(offered[index].body_md).toContain(bodies[index]!);
        } finally {
          initial.layer.closeAll(); initial.layer.stop(); await initial.layer.drain();
          restarted?.layer.closeAll(); restarted?.layer.stop(); await restarted?.layer.drain();
        }
      }, 30_000);
    }
  }
});
