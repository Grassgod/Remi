import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "../../packages/server/src/store/store";
import { startMultiremiServer } from "../../packages/server/src/api/server";

const marker = process.env.MUL395_S9_3B_FIXTURE_AUTH;
if (!marker) throw new Error("Local fixture authentication must be supplied in memory");
const db = openSqliteDatabase(":memory:");
const store = new MultiremiStore(db);
const workspace = store.ensureLocalWorkspace();
const user = store.getCurrentUser();
const member = store.listWorkspaceMembers(workspace.id).find((row) => row.userId === user.id)!;
const now = "2026-09-28T05:00:00.000Z";
// MUL-472 R4's fixed fixture, with explicit member assignments so My Issues has rows.
for (const [id, title, status] of [
  ["iss_pin_me", "Pinned fixture", "todo"], ["iss_badge_a", "Review fixture", "in_review"],
  ["iss_badge_b", "Blocked fixture", "blocked"], ["iss_detail", "Detail page fixture", "in_progress"],
] as const) store.createIssue({ id, title, description: `${title} description`, status, priority: "medium",
  assigneeType: "member", assigneeId: member.id });
const session = store.getOrCreateDefaultIssueSession("iss_detail", user.id);
for (let i = 0; i < 6; i++) store.createIssueComment("iss_detail", {
  issueSessionId: session.id, authorType: "member", authorId: user.id, body: `Fixture comment ${i + 1}`,
});
const comments = await Bun.file(new URL("../../reports/performance/MUL-472-r4/MUL-454-fixture.json", import.meta.url)).json() as Array<{ content: string }>;
if (comments.length !== 210) throw new Error("MUL-454 fixture must contain 210 comments");
store.createIssue({ id: "iss_mul454", title: "MUL-454 local 210-comment fixture", description: "Fixed synthetic QA fixture",
  status: "in_progress", priority: "medium", assigneeType: "member", assigneeId: member.id });
const longSession = store.getOrCreateDefaultIssueSession("iss_mul454", user.id);
for (const comment of comments) store.createIssueComment("iss_mul454", {
  issueSessionId: longSession.id, authorType: "member", authorId: user.id, body: comment.content,
});
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
for (let i = 1; i <= 2; i++) db.run(`INSERT INTO multiremi_inbox_items
  (id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity, actor_type, actor_id, type, title, body, details, read, archived, created_at)
  VALUES (?, ?, 'iss_detail', ?, 'member', ?, 'info', 'member', ?, 'issue_assigned', ?, '', '{}', 0, 0, ?)`,
  [`inb_probe_${i}`, workspace.id, member.id, member.id, user.id, `Probe notification ${i}`, new Date(Date.parse(now) + i * 1000).toISOString()]);
db.run(`INSERT INTO multiremi_workspace_invitations
  (id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status, expires_at, created_at, updated_at)
  VALUES ('inv_fixture', ?, ?, ?, ?, 'member', 'pending', '2026-10-28T00:00:00Z', ?, ?)`,
  [workspace.id, user.id, user.email, user.id, now, now]);
const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 18560, authToken: marker, backgroundJobs: false });
const control = Bun.serve({ hostname: "127.0.0.1", port: 18561, fetch(request) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/reset-inbox") return new Response("not found", { status: 404 });
  db.run("UPDATE multiremi_inbox_items SET read = 0");
  return new Response("reset");
} });
console.log("MUL-395 S9-3b local fixture ready on 18560; control on 18561");
function stop() { control.stop(true); server.stop(true); db.close(); process.exit(0); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await new Promise(() => {});
