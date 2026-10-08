import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createConversationLogFillReader } from "@multiremi/api/hub/conversation-log-fill-reader.js";
import type { ConversationLogEntry, ConversationLogPatch } from "@multiremi/contracts/conversation-log.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("conversation log read-side layers (MUL-501 2b first segment)", () => {
  it("projects wake provenance and derives layers only in display reads without storing or filtering them", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Lead", provider: "codex" });
    const issue = store.createIssue({ title: "Layers" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const sent = store.sendMessage({ session_id: session.id, sender: { type: "platform", id: null },
      to: { type: "agent", ref: agent.id }, message_kind: "report", wake_requested: "now",
      body_md: "QA completed a task. Read the latest Session Updates." });
    expect(sent.turn_id).toBeString();
    expect(sent.wake_reason).toBe("platform_to_owner");
    const app = createMultiremiApp({ store });
    const readEntry = async (id: string) => {
      const response = await app.request(`/api/sessions/${session.id}/log/entry?id=${id}`);
      expect(response.status).toBe(200);
      return await response.json() as ConversationLogEntry;
    };
    const turn = await readEntry(sent.turn_id!);
    expect(turn).toMatchObject({ layer: "system", body_md: sent.message.body_md, metadata: {
      wake_source: "platform_to_owner", trigger_message_id: sent.message.id,
    } });
    expect((await readEntry(sent.message.id)).layer).toBe("system");
    const comment = store.createIssueComment(issue.id, { body: "Human comment" });
    const response = await app.request(`/api/sessions/${session.id}/log`);
    expect(response.status).toBe(200);
    const window = await response.json() as { entries: ConversationLogEntry[] };
    expect(window.entries.map(row => [row.id, row.layer])).toEqual([
      [store.getConversationLogEntry(session.id, 0)!.id, "conversation"],
      [sent.message.id, "system"], [turn.id, "system"], [comment.id, "conversation"],
    ]);
    expect((await readEntry(store.getConversationLogEntry(session.id, 0)!.id)).layer).toBe("conversation");
    expect(store.listConversationLogEntries(session.id).every(row => row.layer === undefined)).toBe(true);
    const persisted = db!.query("SELECT body_md,metadata FROM multiremi_conversation_log WHERE id=?").get(turn.id);
    expect(persisted).toMatchObject({ body_md: "", metadata: "{}" });
    db!.run("UPDATE multiremi_turns SET wake_source='human_sender' WHERE id=?", [turn.id]);
    expect((await readEntry(turn.id)).layer).toBe("conversation");
  });

  it("keeps display fields out of message ranges, agent JSONL and Hub payloads before and after /log reads", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Lead", provider: "codex" });
    const reader = store.createAgent({ name: "Reader", provider: "codex" });
    const issue = store.createIssue({ title: "Wire compatibility" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const liveEntries: Array<ConversationLogEntry | ConversationLogPatch> = [];
    const detach = store.subscribeConversationLog({ onEntry: (_sessionId, entry) => liveEntries.push(entry) });
    try {
      const sent = store.sendMessage({ session_id: session.id, sender: { type: "platform", id: null },
        to: { type: "agent", ref: agent.id }, message_kind: "report", wake_requested: "now",
        body_md: "QA could not complete a task you delegated." });
      db!.run("UPDATE multiremi_turns SET input_from_seq=0,input_to_seq=? WHERE id=?", [sent.message.seq, sent.turn_id!]);
      const task = store.createSessionTask(session.id, { agentId: reader.id, prompt: "Read the report" });
      const head = store.getConversationLogHead(session.id)!.headSeq;
      const app = createMultiremiApp({ store });
      const fill = createConversationLogFillReader(store, null);
      const rangeUrl = `/api/sessions/${session.id}/messages?from=0&to=${head}`;
      const messageResponse = await app.request(rangeUrl);
      expect(messageResponse.status).toBe(200);
      const messageBytes = await messageResponse.text();
      const range = JSON.parse(messageBytes) as { entries: ConversationLogEntry[] };
      const turn = range.entries.find(entry => entry.id === sent.turn_id)!;
      expect(turn).toBeDefined();
      // This is the card metadata wire from main 8d761976, including key order.
      const legacyMetadata = {
        status: "queued", summary: null, event_count: null, tool_call_count: null,
        type_histogram: null, model: null, trace_ref: null, usage: [], failure_reason: null,
        final_entry_id: null, elapsed_ms: null, inbox: { delivered_from_seq: 0, delivered_to_seq: sent.message.seq },
        assignee_agent_id: agent.id, attempt: 1, source_event_id: null, continued_from_task_id: null,
        delegation_id: null, delegated_by_agent_id: null, turn_id: sent.turn_id,
        current_attempt_id: store.getTurn(sent.turn_id!)!.current_attempt_id, legacy_prompt: sent.message.body_md,
      };
      expect(JSON.stringify(turn.metadata)).toBe(JSON.stringify(legacyMetadata));
      const projection = store.buildTaskSessionProjection(task.id)!;
      const projectedTurn = projection.jsonl.split("\n").map(line => JSON.parse(line))
        .find(line => line.metadata?.turn_id === sent.turn_id);
      expect(projectedTurn).toBeDefined();
      // Agent JSONL omits mutable card state and serializes metadata in stable order.
      expect(JSON.stringify(projectedTurn.metadata)).toBe(JSON.stringify({
        assignee_agent_id: agent.id, attempt: 1, continued_from_task_id: null,
        current_attempt_id: legacyMetadata.current_attempt_id, delegated_by_agent_id: null, delegation_id: null,
        inbox: { delivered_from_seq: 0, delivered_to_seq: sent.message.seq }, legacy_prompt: sent.message.body_md,
        source_event_id: null, trace_ref: null, turn_id: sent.turn_id,
      }));
      const frames = await fill.readRange(`log:${session.id}`, 0, head);
      expect(frames.find(frame => (frame.payload as ConversationLogEntry).id === sent.turn_id)?.payload)
        .toMatchObject({ metadata: legacyMetadata });
      const hubBytes = JSON.stringify(frames);
      const displayFields = /"(?:wake_source|trigger_message_id|layer)":/;
      for (const bytes of [messageBytes, projection.jsonl, hubBytes, JSON.stringify(liveEntries)]) {
        expect(bytes).not.toMatch(displayFields);
      }
      const logResponse = await app.request(`/api/sessions/${session.id}/log`);
      expect(logResponse.status).toBe(200);
      const window = await logResponse.json() as { entries: ConversationLogEntry[] };
      expect(window.entries.find(entry => entry.id === sent.turn_id)).toMatchObject({ layer: "system",
        metadata: { wake_source: "platform_to_owner", trigger_message_id: sent.message.id } });
      expect(await (await app.request(rangeUrl)).text()).toBe(messageBytes);
      expect(JSON.stringify(await fill.readRange(`log:${session.id}`, 0, head))).toBe(hubBytes);
      const afterProjection = store.buildTaskSessionProjection(task.id)!;
      expect(afterProjection.jsonl).toBe(projection.jsonl);
      expect(afterProjection.estimatedTokens).toBe(projection.estimatedTokens);
      expect(liveEntries.some(entry => "id" in entry && entry.id === sent.turn_id)).toBe(true);
    } finally { detach(); }
  });

  it("returns workspace clearing in the activity sidecar with the name and field intact", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Original project", workspaceId: "local" });
    const issue = store.createIssue({ title: "Move", projectId: project.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const target = store.createWorkspace({ name: "Target", slug: "layer-target" });
    store.updateIssue(issue.id, { workspaceId: target.id });
    const app = createMultiremiApp({ store });
    // Existing session histories retain the original workspace after a move.
    const response = await app.request(`/api/sessions/${session.id}/log?with_activity=1`);
    expect(response.status).toBe(200);
    const window = await response.json();
    expect(window.activities.find((a: { action: string }) => a.action === "workspace_move_cleared"))
      .toMatchObject({ details: { field: "project", name: project.title } });
    expect(window.entries.find((row: { metadata: { type?: string } }) => row.metadata.type === "workspace_move_cleared"))
      .toMatchObject({ layer: "system" });
  });
});
