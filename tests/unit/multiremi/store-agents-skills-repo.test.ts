// Sibling test for packages/server/src/store/repos/agents-skills-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AgentsSkillsRepo } from "@multiremi/store/repos/agents-skills-repo.js";

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

  it("normalizes blank avatar_url to NULL on create and update", () => {
    const repo = createRepo();
    const created = repo.createAgent({ name: "Faceless", provider: "claude", avatar_url: "" });
    expect(created.avatarUrl).toBeNull();

    const withAvatar = repo.updateAgent(created.id, { avatar_url: "/api/attachments/att_1/content" });
    expect(withAvatar.avatarUrl).toBe("/api/attachments/att_1/content");

    // Clearing from the edit dialog submits "" — it must not persist as ''.
    const cleared = repo.updateAgent(created.id, { avatar_url: "  " });
    expect(cleared.avatarUrl).toBeNull();
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
});
