// MUL-389: the claim hydrates the selected task and nothing else.
//
// The eligibility loops used to call the full `getAgent` (Skills + Skill files) for every
// candidate and re-run `getTaskWithAgent` twice, so a workspace with several hundreds of KB of
// Skills per Agent crossed megabytes over the bridge to pick one task whose own payload was
// 600 KB. These tests pin the two properties that must hold after the fix:
//   1. the claim still selects exactly the task it selected before (priority, then created_at,
//      profile tasks, chat affinity, stale-dispatch recovery), and the selected task still
//      carries its Skills and files in full;
//   2. the eligibility decision never needs a Skill body, so reading one must not happen per
//      candidate Agent.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { createStore, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiRuntime } from "@multiremi/contracts/types.js";

afterEach(resetMultiremiTestEnv);

/** Counts the statements a block issues, by normalized SQL text. */
function counting(store: MultiremiStore): { sql: string[]; stop(): Map<string, number> } {
  const statements: string[] = [];
  // The store holds its own `SqlDatabase`, so wrap the raw handle it was built with.
  const handle = (store as unknown as { db: { query(sql: string): unknown; run?(sql: string, ...args: unknown[]): unknown } }).db;
  const original = handle.query.bind(handle);
  (handle as { query(sql: string): unknown }).query = (sql: string) => {
    statements.push(sql.replace(/\s+/g, " ").trim());
    return original(sql);
  };
  return {
    sql: statements,
    stop: () => {
      (handle as { query(sql: string): unknown }).query = original;
      const counts = new Map<string, number>();
      for (const sql of statements) counts.set(sql, (counts.get(sql) ?? 0) + 1);
      return counts;
    },
  };
}

function fixture(options: {
  agents?: number;
  skillFileBytes?: number;
  withProject?: boolean;
} = {}): { store: MultiremiStore; runtime: MultiremiRuntime } {
  const store = createStore();
  store.ensureLocalWorkspace();
  if (options.withProject) {
    store.updateWorkspace("local", {
      repos: [{ id: "repo_bench", name: "bench", url: "https://github.com/example/bench", source: "github", default_branch: "main" }],
    });
  }
  const runtime = store.registerRuntime({
    id: "rt_hydrate",
    name: "Hydrate runtime",
    provider: "codex",
    daemonId: "daemon-hydrate",
    workspaceId: "local",
    ownerId: "local",
    status: "online",
    maxConcurrency: 8,
    metadata: { codex_profiles: 1, parallel_agent_execution: 1 },
  });
  const project = options.withProject
    ? store.createProject({
      id: "prj_hydrate",
      title: "Hydrate project",
      workspaceId: "local",
      resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/example/bench", id: "repo_bench" } }],
    })
    : null;
  const agents = Array.from({ length: options.agents ?? 4 }, (_value, index) => {
    const agent = store.createAgent({
      id: `agt_hydrate_${index}`,
      name: `Hydrate agent ${index}`,
      provider: "codex",
      workspaceId: "local",
      runtimeId: runtime.id,
      model: index === 0 ? "gpt-5-codex" : null,
    });
    const skill = store.createSkill({
      workspaceId: "local",
      name: `Hydrate skill ${index}`,
      content: `# skill ${index}`,
      files: [{ path: "notes.md", content: "x".repeat(options.skillFileBytes ?? 1_000) }],
    });
    store.setAgentSkills(agent.id, [skill.id!]);
    return agent;
  });

  const issue = store.createIssue({ title: "Hydrate issue", workspaceId: "local", projectId: project?.id ?? null });
  // The selected task: highest priority.
  store.createTask({ agentId: agents[0]!.id, issueId: issue.id, prompt: "selected", priority: 100 });
  for (let index = 1; index < agents.length; index += 1) {
    // Profile tasks: the claim walks every one of these and hydrates its Agent.
    store.createTask({
      agentId: agents[index]!.id,
      prompt: `profile ${index}`,
      priority: 50 - index,
      codexProfile: { name: "bench", base_url: "http://127.0.0.1:8000/v1", model: "custom", env_key: "REMI_BENCH_KEY", auth_mode: "env" },
    });
    // Queued chat turns: `refreshQueuedChatAffinity` walks every one of these.
    const chat = store.createChatSession({ agentId: agents[index]!.id, workspaceId: "local", projectId: project?.id ?? null });
    store.sendChatMessage(chat.id, { body: `chat ${index}` });
  }
  return { store, runtime };
}

describe("claim hydrates only the selected task", () => {
  it("picks the highest-priority task and keeps its Skills and files complete", () => {
    const { store, runtime } = fixture();
    const claimed = store.claimTask(runtime.id, { supportsBinarySkillFiles: true })!;
    expect(claimed.id).toBe(store.listTasks().find((task) => task.priority === 100)!.id);
    expect(claimed.agent?.id).toBe("agt_hydrate_0");
    // The selected task's own payload is still complete: the Skill body and its file content.
    expect(claimed.agent?.skills).toHaveLength(1);
    expect(claimed.agent?.skills[0]!.files?.[0]).toMatchObject({ path: "notes.md", content: "x".repeat(1_000) });
  });

  it("breaks a priority tie by created_at, exactly as the SQL ordering does", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_tie", name: "Tie runtime", provider: "codex", workspaceId: "local",
      ownerId: "local", status: "online", maxConcurrency: 2,
    });
    const agent = store.createAgent({ name: "Tie agent", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const first = store.createTask({ agentId: agent.id, prompt: "first", priority: 10 });
    const second = store.createTask({ agentId: agent.id, prompt: "second", priority: 10 });
    // Same session lane, so the SQL's `created_at ASC` decides; the later row must lose.
    expect(store.getTask(second.id)!.createdAt >= store.getTask(first.id)!.createdAt).toBe(true);
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
  });

  it("still excludes a profile task the runtime cannot serve and claims the next one", () => {
    const { store, runtime } = fixture({ agents: 3 });
    // Drop the runtime's model catalog so the profile task's frozen connection cannot be honoured.
    store.updateRuntime(runtime.id, { metadata: { codex_profiles: 0, parallel_agent_execution: 1 } });
    const claimed = store.claimTask(runtime.id, { supportsBinarySkillFiles: true });
    // Whatever it picks, it must not be a profile task: this runtime advertises no profiles.
    expect(claimed?.codexProfile ?? null).toBeNull();
  });

  it("recovers a stale dispatch instead of leaving it stranded", () => {
    const { store, runtime } = fixture({ agents: 2 });
    const dispatched = store.claimTask(runtime.id, { supportsBinarySkillFiles: true })!;
    const stale = "2000-01-01T00:00:00.000Z";
    (store as unknown as { db: { run(sql: string, ...args: unknown[]): unknown } })
      .db.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", [stale, dispatched.id]);

    const recovered = store.claimTask(runtime.id, { supportsBinarySkillFiles: true });
    expect(recovered?.id).toBe(dispatched.id);
    expect(store.getTask(dispatched.id)?.dispatchedAt).not.toBe(stale);
  });

  it("never reads a Skill file for an Agent that is only being tested for eligibility", () => {
    const { store, runtime } = fixture({ agents: 5, skillFileBytes: 200_000 });
    const counter = counting(store);
    const claimed = store.claimTask(runtime.id, { supportsBinarySkillFiles: true })!;
    const counts = counter.stop();

    const skillFileReads = [...counts.entries()]
      .filter(([sql]) => sql.includes("FROM multiremi_skill_files"))
      .reduce((sum, [, count]) => sum + count, 0);
    // Exactly one Agent is shipped, so its Skill files are read once. The four candidates that
    // lose the claim must not have their file bodies read at all.
    expect(skillFileReads).toBe(1);
    expect(claimed.agent?.skills[0]!.files?.[0]!.content).toHaveLength(200_000);
  });

  it("reads no Skill file at all when the queue is empty", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_empty", name: "Empty runtime", provider: "codex", workspaceId: "local",
      ownerId: "local", status: "online",
    });
    const agent = store.createAgent({ name: "Idle agent", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const skill = store.createSkill({
      workspaceId: "local", name: "Idle skill", content: "# idle",
      files: [{ path: "notes.md", content: "x".repeat(50_000) }],
    });
    store.setAgentSkills(agent.id, [skill.id!]);

    const counter = counting(store);
    expect(store.claimTask(runtime.id)).toBeNull();
    const counts = counter.stop();
    const skillFileReads = [...counts.entries()]
      .filter(([sql]) => sql.includes("FROM multiremi_skill_files"))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(skillFileReads).toBe(0);
  });

  it("delivers the same task over HTTP as the store-level claim", async () => {
    const { store, runtime } = fixture({ agents: 3 });
    const expected = store.listTasks().find((task) => task.priority === 100)!.id;
    const token = await store.createAccessToken({ workspaceId: "local", name: "d", type: "daemon", daemonId: "daemon-hydrate" });
    const app = createMultiremiApp({ store, authToken: "MASTER", backgroundJobs: false });
    const response = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ supports_binary_skill_files: true }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { task: { id: string; agent: { skills: Array<{ files?: unknown[] }> } } };
    expect(body.task.id).toBe(expected);
    expect(body.task.agent.skills[0]!.files).toHaveLength(1);
  });

  it("keeps the daemon client's claim normalization working against the new path", async () => {
    const { store, runtime } = fixture({ agents: 2 });
    const token = await store.createAccessToken({ workspaceId: "local", name: "d", type: "daemon", daemonId: "daemon-hydrate" });
    const app = createMultiremiApp({ store, authToken: "MASTER", backgroundJobs: false });
    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const claimed = await new MultiremiDaemonClient("https://remi.example", token.token).claimTask(runtime.id);
    expect(claimed?.id).toBe(store.listTasks().find((task) => task.priority === 100)!.id);
    expect(claimed?.agent?.skills).toHaveLength(1);
  });
});
