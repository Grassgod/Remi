/**
 * MUL-357 evidence: dump the exact visible-task set for several identities and
 * several authorization rules, so the same fixture can be run on the parent
 * commit and on the change and diffed byte for byte.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

const out = process.argv[2] ?? "/tmp/vis.json";
const store = new MultiremiStore(new Database(":memory:"));
store.ensureLocalWorkspace();
store.createWorkspace({ id: "ws_other", name: "Other", slug: "other", issuePrefix: "OTH" });
const shared = store.createAgent({ id: "agt_shared", name: "Shared", provider: "codex", workspaceId: "local", visibility: "workspace" });
const mine = store.createAgent({ id: "agt_mine", name: "Mine", provider: "codex", workspaceId: "local", visibility: "private", ownerId: "usr_alice" });
const theirs = store.createAgent({ id: "agt_theirs", name: "Theirs", provider: "codex", workspaceId: "local", visibility: "private", ownerId: "usr_bob" });
const foreign = store.createAgent({ id: "agt_foreign", name: "Foreign", provider: "codex", workspaceId: "ws_other", visibility: "workspace" });
store.createWorkspaceMember({ workspaceId: "local", userId: "usr_alice", name: "Alice", role: "member" });
store.createWorkspaceMember({ workspaceId: "local", userId: "usr_bob", name: "Bob", role: "admin" });
store.createWorkspaceMember({ workspaceId: "ws_other", userId: "usr_carol", name: "Carol", role: "member" });
const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "usr_alice", workspaceId: "local" });
const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "usr_bob", workspaceId: "local" });
const carol = await store.createAccessToken({ name: "Carol", type: "pat", userId: "usr_carol", workspaceId: "ws_other" });
const app = createMultiremiApp({ store, authToken: "root-secret" });

const label = new Map<string, string>();
const note = (taskId: string, name: string) => label.set(taskId, name);
note(store.createTask({ agentId: shared.id, prompt: "shared work" }).id, "sharedAgentOrdinary");
note(store.createTask({ agentId: mine.id, prompt: "alice private agent" }).id, "alicePrivateAgentOrdinary");
note(store.createTask({ agentId: theirs.id, prompt: "bob private agent" }).id, "bobPrivateAgentOrdinary");
note(store.createTask({ agentId: foreign.id, prompt: "foreign", workspaceId: "ws_other" }).id, "foreignWorkspaceOrdinary");
for (const [agent, creator, name] of [
  [shared, "usr_alice", "sharedAgentAliceChat"],
  [shared, "usr_bob", "sharedAgentBobChat"],
  [mine, "usr_bob", "alicePrivateAgentBobChat"],
  [mine, "usr_alice", "alicePrivateAgentAliceChat"],
  [foreign, "usr_carol", "foreignWorkspaceCarolChat"],
] as const) {
  const session = store.createChatSession({ agentId: agent.id, creatorId: creator, workspaceId: agent.workspaceId });
  note(store.sendChatMessage(session.id, { content: name }).task.id, name);
}

const identities: Record<string, Record<string, string>> = {
  root: {},
  alice: { Authorization: `Bearer ${alice.token}` },
  bob: { Authorization: `Bearer ${bob.token}` },
  carol: { Authorization: `Bearer ${carol.token}` },
};
const result: Record<string, unknown> = {};
for (const [identity, headers] of Object.entries(identities)) {
  const list = await app.request("/api/multiremi/tasks", { headers });
  const body = await list.json() as { tasks?: Array<{ id: string }> };
  result[`${identity}.list`] = (body.tasks ?? []).map((task) => label.get(task.id) ?? task.id).sort();
  result[`${identity}.list.status`] = list.status;
  result[`${identity}.list.body`] = body.tasks ? "tasks" : body;
  const perTask: Record<string, number> = {};
  for (const [taskId, name] of label) {
    const detail = await app.request(`/api/multiremi/tasks/${taskId}`, { headers });
    const messages = await app.request(`/api/tasks/${taskId}/messages`, { headers });
    perTask[name] = detail.status * 1000 + messages.status;
  }
  result[`${identity}.detailStatusAndMessages`] = perTask;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${out}`);
for (const key of Object.keys(result).filter((key) => key.endsWith(".list"))) {
  console.log(key, JSON.stringify(result[key]));
}
