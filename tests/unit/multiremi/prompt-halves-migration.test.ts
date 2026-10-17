import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@multiremi/store/migrations.js";
import { LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT } from "@multiremi/contracts/remi-rules.js";
import { readWorkspacePromptSettings } from "../../../packages/server/src/prompts/workspace-settings.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("20261019_merge_prompt_halves (ADR 0023)", () => {
  it("folds a workspace's two prompts and a Project's delta instructions into one, once", () => {
    const store = createLocalStore();
    const project = store.createProject({ title: "Halves", instructions: "Bootstrap rule" });
    db!.run("UPDATE multiremi_projects SET instructions = ?, delta_instructions = ? WHERE id = ?", ["Bootstrap rule", "Delta rule", project.id]);
    db!.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify({
      prompt_bootstrap_appendix: `${LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nWorkspace rule`,
      prompt_delta_appendix: "Every turn rule",
      prompt_revision: 3,
      other: true,
    })]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = '20261019_merge_prompt_halves'");

    runMigrations(db! as never);

    const settings = JSON.parse((db!.query("SELECT settings FROM multiremi_workspaces WHERE id = 'local'").get() as { settings: string }).settings);
    expect(settings).toMatchObject({
      prompt_appendix: "Workspace rule\n\nEvery turn rule",
      // An image from before still reads its own keys.
      prompt_bootstrap_appendix: `${LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nWorkspace rule`,
      prompt_delta_appendix: "Every turn rule",
      prompt_revision: 3,
      // The revision the prompt was folded at: a later edit on an older image is newer and is read instead.
      prompt_appendix_revision: 3,
      other: true,
    });
    expect(readWorkspacePromptSettings(store.getWorkspace("local")!).prompt).toBe("Workspace rule\n\nEvery turn rule");
    expect(store.getProject(project.id)).toMatchObject({ instructions: "Bootstrap rule\n\nDelta rule", deltaInstructions: "" });

    // Applied once: a later run does not append again.
    db!.run("UPDATE multiremi_projects SET delta_instructions = 'Late delta' WHERE id = ?", [project.id]);
    runMigrations(db! as never);
    expect(db!.query("SELECT instructions FROM multiremi_projects WHERE id = ?").get(project.id))
      .toEqual({ instructions: "Bootstrap rule\n\nDelta rule" });
  });

  it("reads a delta an older image wrote after the migration as part of the instructions, and clears it on the next save", () => {
    const store = createLocalStore();
    const project = store.createProject({ title: "Rolled back", instructions: "Bootstrap rule" });
    // A rollback to an image from before ADR 0023 edits the delta half again.
    db!.run("UPDATE multiremi_projects SET delta_instructions = ?, instructions_revision = 2 WHERE id = ?", ["Edited on the old image", project.id]);
    expect(store.getProject(project.id)).toMatchObject({
      instructions: "Bootstrap rule\n\nEdited on the old image", deltaInstructions: "", instructionsRevision: 2 });

    // Any later save writes the one field and clears the half, without counting as an instructions edit.
    store.updateProject(project.id, { title: "Rolled back and up" });
    expect(db!.query("SELECT instructions, delta_instructions, instructions_revision FROM multiremi_projects WHERE id = ?").get(project.id))
      .toEqual({ instructions: "Bootstrap rule\n\nEdited on the old image", delta_instructions: "", instructions_revision: 2 });
    expect(store.getProject(project.id)).toMatchObject({ title: "Rolled back and up", instructions: "Bootstrap rule\n\nEdited on the old image" });
  });
});
