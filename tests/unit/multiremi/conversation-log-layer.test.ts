import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("conversation log read-side layers (MUL-501 2b first segment)", () => {
  it("projects wake provenance and derives layers without storing or filtering them", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Lead", provider: "codex" });
    const issue = store.createIssue({ title: "Layers" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const sent = store.sendMessage({ session_id: session.id, sender: { type: "platform", id: null },
      to: { type: "agent", ref: agent.id }, message_kind: "report", wake_requested: "now",
      body_md: "QA completed a task. Read the latest Session Updates." });
    expect(sent.turn_id).toBeString();
    expect(sent.wake_reason).toBe("platform_to_owner");
    const turn = store.getConversationLogEntryById(sent.turn_id!)!;
    expect(turn).toMatchObject({ layer: "system", body_md: sent.message.body_md, metadata: {
      wake_source: "platform_to_owner", trigger_message_id: sent.message.id,
    } });
    expect(store.getConversationLogEntryById(sent.message.id)?.layer).toBe("system");
    const comment = store.createIssueComment(issue.id, { body: "Human comment" });
    const window = store.conversationLogWindow(session.id);
    expect(window.entries.map(row => [row.id, row.layer])).toEqual([
      [store.getConversationLogEntry(session.id, 0)!.id, "conversation"],
      [sent.message.id, "system"], [turn.id, "system"], [comment.id, "conversation"],
    ]);
    expect(store.getConversationLogEntry(session.id, 0)?.layer).toBe("conversation");
    expect(store.listConversationLogEntries(session.id).every(row => row.layer !== undefined)).toBe(true);
    const persisted = db!.query("SELECT body_md,metadata FROM multiremi_conversation_log WHERE id=?").get(turn.id);
    expect(persisted).toMatchObject({ body_md: "", metadata: "{}" });
    db!.run("UPDATE multiremi_turns SET wake_source='human_sender' WHERE id=?", [turn.id]);
    expect(store.getConversationLogEntryById(turn.id)?.layer).toBe("conversation");
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
