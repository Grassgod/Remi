// Sibling test for packages/server/src/store/repos/agents-skills-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import {
  AgentsSkillsRepo,
  CONCIERGE_AGENT_INSTRUCTIONS,
} from "@multiremi/store/repos/agents-skills-repo.js";

let db: Database | null = null;

function createRepo(): AgentsSkillsRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  const store = new MultiremiStore(db);
  return new AgentsSkillsRepo(new StoreContext(db, () => store));
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("AgentsSkillsRepo", () => {
  it("creates and reads back an agent", () => {
    const repo = createRepo();
    const agent = repo.createAgent({ name: "Repo worker", provider: "claude", workspaceId: "local" });

    expect(agent.name).toBe("Repo worker");
    expect(agent.workspaceId).toBe("local");
    expect(repo.getAgent(agent.id)?.id).toBe(agent.id);
    expect(repo.listAgents().map((entry) => entry.id)).toContain(agent.id);
  });

  it("archives an agent out of listAgents and restores it", () => {
    const repo = createRepo();
    const agent = repo.createAgent({ name: "Temp worker", provider: "claude" });

    expect(repo.archiveAgent(agent.id).archivedAt).toBeTruthy();
    expect(repo.listAgents().map((entry) => entry.id)).not.toContain(agent.id);

    expect(repo.restoreAgent(agent.id).archivedAt).toBeNull();
    expect(repo.listAgents().map((entry) => entry.id)).toContain(agent.id);
  });

  it("attaches skills with their files to an agent", () => {
    const repo = createRepo();
    const agent = repo.createAgent({ name: "Skilled", provider: "claude" });
    const skill = repo.createSkill({
      name: "review",
      content: "how to review",
      files: [{ path: "checklist.md", content: "- read the diff" }],
    });

    const skillId = skill.id!;
    const attached = repo.setAgentSkills(agent.id, [skillId]);
    expect(attached.map((entry) => entry.id)).toEqual([skillId]);
    expect(repo.listAgentSkills(agent.id)[0]!.files?.map((file) => file.path)).toEqual(["checklist.md"]);
    expect(repo.listSkillFiles(skillId).map((file) => file.content)).toEqual(["- read the diff"]);
  });

  it("ensures one workspace concierge agent with the canonical instructions", () => {
    const repo = createRepo();

    const first = repo.ensureConciergeAgent("local", "alice", "codex");
    const second = repo.ensureConciergeAgent("local", "bob", "claude");

    expect(second.id).toBe(first.id);
    expect(first.id).toBe("agt_concierge_local");
    expect(first.name).toBe("飞书管家");
    expect(first.provider).toBe("codex");
    expect(first.ownerId).toBe("alice");
    expect(first.visibility).toBe("workspace");
    expect(first.maxConcurrentTasks).toBe(20);
    expect(first.instructions).toBe(CONCIERGE_AGENT_INSTRUCTIONS);
  });
});
