import { Database } from "bun:sqlite";
import { MultiremiStore } from "../../../../packages/server/src/store/store.ts";
import { startMultiremiServer } from "../../../../packages/server/src/api/server.ts";

const marker = process.env.MUL472_R4_FIXTURE_AUTH;
if (!marker) throw new Error("MUL472_R4_FIXTURE_AUTH is required for the local fixture");
const db = new Database(":memory:");
const store = new MultiremiStore(db);
const workspace = store.ensureLocalWorkspace();
const user = store.getCurrentUser();
const member = store.listWorkspaceMembers(workspace.id).find((m) => m.userId === user.id)!;
const now = "2026-09-28T05:00:00.000Z";
for (const [id, title, status] of [
  ["iss_pin_me", "Pinned fixture", "todo"],
  ["iss_badge_a", "Review fixture", "in_review"],
  ["iss_badge_b", "Blocked fixture", "blocked"],
  ["iss_detail", "Detail page fixture", "in_progress"],
] as const) {
  store.createIssue({ id, title, description: `${title} description`, status, priority: "medium" });
}
const session = store.getOrCreateDefaultIssueSession("iss_detail", user.id);
for (let i = 0; i < 6; i++) {
  store.createIssueComment("iss_detail", { issueSessionId: session.id, authorType: "member", authorId: user.id, body: `Fixture comment ${i + 1}` });
}
const longComments = await Bun.file(`${import.meta.dir}/../MUL-454-fixture.json`).json() as Array<{ content: string }>;
if (longComments.length !== 210) throw new Error("MUL-454 fixture must contain 210 comments");
store.createIssue({ id: "iss_mul454", title: "MUL-454 local 210-comment fixture", description: "Fixed synthetic sample from QA attachment att_608df28b8e12; local authors only", status: "in_progress", priority: "medium" });
const longSession = store.getOrCreateDefaultIssueSession("iss_mul454", user.id);
for (const comment of longComments) store.createIssueComment("iss_mul454", { issueSessionId: longSession.id, authorType: "member", authorId: user.id, body: comment.content });
store.createPinnedItem({ id: "pin_fixture", workspaceId: workspace.id, userId: user.id, itemType: "issue", itemId: "iss_pin_me" });
const agent = store.createAgent({ id: "agt_fixture", name: "Fixture Agent", provider: "codex" } as never);
const chat = store.createChatSession({ id: "cs_fixture", agentId: agent.id, workspaceId: workspace.id, creatorId: user.id, title: "Fixture chat" });
store.appendChatMessageWithinTransaction({ id: "msg_fixture", chatSessionId: chat.id, role: "user", body: "Fixture user message" });
const chatTask = store.createTask({ id: "tsk_chat_fixture", agentId: agent.id, chatSessionId: chat.id, prompt: "Fixture chat task" } as never);
db.run("UPDATE multiremi_tasks SET status = 'running', started_at = ? WHERE id = ?", [now, chatTask.id]);
store.createSquad({ id: "squad_fixture", name: "Fixture Squad", memberIds: [agent.id] });
store.registerRuntime({ id: "rt_fixture", name: "Fixture Runtime", provider: "codex", runtimeMode: "local", ownerId: user.id, metadata: { cli_version: "1.0.0" } });
const task = store.createTask({ agentId: agent.id, issueId: "iss_pin_me", prompt: "Fixture running task" } as never);
db.run("UPDATE multiremi_tasks SET status = 'running', started_at = ? WHERE id = ?", [now, task.id]);
for (let i = 1; i <= 2; i++) {
  db.run(`INSERT INTO multiremi_inbox_items
    (id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity, actor_type, actor_id, type, title, body, details, read, archived, created_at)
    VALUES (?, ?, 'iss_detail', ?, 'member', ?, 'info', 'member', ?, 'issue_assigned', ?, '', '{}', 0, 0, ?)`,
    [`inb_probe_${i}`, workspace.id, member.id, member.id, user.id, `Probe notification ${i}`, new Date(Date.parse(now) + i * 1000).toISOString()]);
}
db.run(`INSERT INTO multiremi_workspace_invitations
  (id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at)
  VALUES ('inv_fixture', ?, ?, ?, ?, 'member', 'pending', '2026-10-28T00:00:00Z', ?, ?)`,
  [workspace.id, user.id, user.email, user.id, now, now]);
const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 16860,
  authToken: marker, backgroundJobs: false });
console.log("MUL-472 fixture ready on 16860: five issues, 210-comment long sample, two inbox rows, pin=1, invitation=1, badge=2, running chat task=1");
const control = Bun.serve({ hostname: "127.0.0.1", port: 16861, fetch(request) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/reset-inbox") return new Response("not found", { status: 404 });
  db.run("UPDATE multiremi_inbox_items SET read = 0");
  return new Response("reset");
} });
function stop() { control.stop(true); server.stop(true); db.close(); process.exit(0); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await new Promise(() => {});
