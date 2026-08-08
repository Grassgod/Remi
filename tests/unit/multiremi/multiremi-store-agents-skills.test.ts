// Agent lifecycle from the scheduling surfaces plus workspace skill attachment
// and squad membership.
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — agents, workspace skills, and members", () => {
  it("updates and archives agents from scheduling surfaces", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", allowedTools: ["Read"] });
    const updated = store.updateAgent(agent.id, { name: "Codex Pro", allowedTools: ["Read", "Bash"] });
    expect(updated.name).toBe("Codex Pro");
    expect(updated.allowedTools).toHaveLength(2);

    const task = store.createTask({ agentId: agent.id, prompt: "Before archive" });
    expect(task.id).toStartWith("tsk_");
    expect(store.archiveAgent(agent.id).archivedAt).toBeString();
    expect(store.listAgents()).toHaveLength(0);
    expect(() => store.createTask({ agentId: agent.id, prompt: "After archive" })).toThrow("Agent is archived");

    const runtime = store.registerRuntime({ name: "codex-runtime", provider: "codex" });
    expect(store.claimTask(runtime.id)).toBeNull();

    const defaultAgent = store.ensureDefaultAgent("codex");
    store.archiveAgent(defaultAgent.id);
    expect(store.listAgents()).toHaveLength(0);
    expect(store.ensureDefaultAgent("codex").archivedAt).toBeNull();
  });

  it("manages workspace skills, attaches them to agents, and includes files in claims", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Reviewer", provider: "claude" });
    const skill = store.createSkill({
      id: "skl_review",
      workspaceId: "local",
      name: "Review Helper",
      description: "Review pull requests",
      content: "# Review Helper",
      config: { origin: { type: "local" } },
      files: [{ path: "templates/check.md", content: "Check list" }],
    });

    expect(store.listSkills("local")[0].content).toBe("# Review Helper");
    expect(store.listSkills("local", { includeFiles: true })[0].files?.[0].path).toBe("templates/check.md");

    const attached = store.setAgentSkills(agent.id, { skill_ids: [skill.id!] });
    expect(attached[0].name).toBe("Review Helper");
    expect(store.getAgent(agent.id)?.skills[0].files?.[0].content).toBe("Check list");

    const task = store.createTask({ agentId: agent.id, prompt: "Review this" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.agent?.skills[0].name).toBe("Review Helper");
    expect(claimed?.agent?.skills[0].files?.[0].path).toBe("templates/check.md");

    const updated = store.updateSkill(skill.id!, { name: "Review Helper", files: [{ path: "rules.md", content: "Rules" }] });
    expect(updated.files?.[0].path).toBe("rules.md");
    expect(() => store.updateSkill(skill.id!, { files: [{ path: "../../../escape.md", content: "" }] })).toThrow();

    store.archiveSkill(skill.id!);
    expect(store.listAgentSkills(agent.id)).toHaveLength(0);
  });

  it("manages workspace members and squad membership", () => {
    const store = createStore();
    const squad = store.createSquad({ name: "Product squad" });
    const member = store.createWorkspaceMember({ name: "Ada Lovelace", email: "ada@example.com", role: "owner" });

    expect(store.listWorkspaceMembers()).toHaveLength(1);
    expect(() => store.updateWorkspaceMember(member.id, { role: "reviewer" })).toThrow("workspace must have at least one owner");
    expect(() => store.archiveWorkspaceMember(member.id)).toThrow("workspace must have at least one owner");
    const backupOwner = store.createWorkspaceMember({ name: "Backup Owner", email: "backup@example.com", role: "owner" });
    expect(store.updateWorkspaceMember(member.id, { role: "reviewer" }).role).toBe("reviewer");
    expect(store.addSquadMember(squad.id, { memberType: "member", memberId: member.id, role: "reviewer" }).memberType).toBe("member");
    expect(store.listSquadMembers(squad.id)[0]?.memberId).toBe(member.id);

    expect(store.archiveWorkspaceMember(member.id).archivedAt).toBeString();
    expect(store.listWorkspaceMembers()).toHaveLength(1);
    expect(() => store.archiveWorkspaceMember(backupOwner.id)).toThrow("workspace must have at least one owner");
    expect(() => store.addSquadMember(squad.id, { memberType: "member", memberId: member.id })).toThrow("Member is archived");
  });
});
