import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT } from "@multiremi/contracts/remi-rules.js";
import { readWorkspacePromptSettings } from "../../../packages/server/src/prompts/workspace-settings.js";
import { createMultiremiApp } from "@multiremi/api.js";
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

  it("leaves room for the blank line it puts between two full halves, so they can be edited and saved", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const headers = { Authorization: "Bearer MASTER", "content-type": "application/json" };
    const project = store.createProject({ title: "Full halves" });
    // The largest halves the old limits allowed: 4,000 characters each for a Project, 8,000 for a workspace.
    db!.run("UPDATE multiremi_projects SET instructions = ?, delta_instructions = ? WHERE id = ?", ["a".repeat(4_000), "b".repeat(4_000), project.id]);
    db!.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify({
      prompt_bootstrap_appendix: "c".repeat(8_000), prompt_delta_appendix: "d".repeat(8_000), prompt_revision: 1 })]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = '20261019_merge_prompt_halves'");
    runMigrations(db! as never);

    const merged = store.getProject(project.id)!;
    expect([...merged.instructions].length).toBe(8_002);
    const edited = `A${merged.instructions.slice(1)}`;
    const projectSave = await app.request(`/api/projects/${project.id}`, { method: "PUT", headers,
      body: JSON.stringify({ instructions: edited, expected_instructions_revision: merged.instructionsRevision }) });
    expect(projectSave.status).toBe(200);
    const tooLong = await app.request(`/api/projects/${project.id}`, { method: "PUT", headers,
      body: JSON.stringify({ instructions: `${edited}x`, expected_instructions_revision: merged.instructionsRevision + 1 }) });
    expect(tooLong.status).toBe(400);

    const prompt = readWorkspacePromptSettings(store.getWorkspace("local")!).prompt;
    expect([...prompt].length).toBe(16_002);
    const workspaceSave = await app.request("/api/workspaces/local/prompts", { method: "PUT", headers,
      body: JSON.stringify({ prompt: `C${prompt.slice(1)}`, expectedRevision: 1 }) });
    expect(workspaceSave.status).toBe(200);
    const workspaceTooLong = await app.request("/api/workspaces/local/prompts", { method: "PUT", headers,
      body: JSON.stringify({ prompt: `C${prompt}`, expectedRevision: 2 }) });
    expect(workspaceTooLong.status).toBe(400);
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

// The same two migrations on the PostgreSQL chain, when a test server is configured.
const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!PG_ADMIN_URL)("ADR 0023 migrations on PostgreSQL", () => {
  const name = `multiremi_pgtest_halves_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const databaseUrl = () => { const url = new URL(PG_ADMIN_URL!); url.pathname = `/${name}`; return url.toString(); };
  let pg: PostgresSyncDatabase;
  let store: MultiremiStore;
  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL!, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await admin.end();
    pg = new PostgresSyncDatabase(databaseUrl());
    store = new MultiremiStore(pg);
    store.ensureLocalWorkspace();
  });
  afterAll(async () => {
    pg?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL!, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("folds the halves and records each attempt's AGENTS.md notes", () => {
    const project = store.createProject({ title: "PG halves", instructions: "Bootstrap rule" });
    pg.run("UPDATE multiremi_projects SET instructions = ?, delta_instructions = ? WHERE id = ?", ["Bootstrap rule", "Delta rule", project.id]);
    pg.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify({
      prompt_bootstrap_appendix: `${LEGACY_DEFAULT_WORKSPACE_BOOTSTRAP_PROMPT}\n\nWorkspace rule`, prompt_delta_appendix: "Every turn rule", prompt_revision: 2 })]);
    pg.run("DELETE FROM multiremi_schema_migrations WHERE id = '20261019_merge_prompt_halves'");
    runMigrations(pg as never);
    const settings = JSON.parse((pg.query("SELECT settings FROM multiremi_workspaces WHERE id = 'local'").get() as { settings: string }).settings);
    expect(settings).toMatchObject({ prompt_appendix: "Workspace rule\n\nEvery turn rule", prompt_appendix_revision: 2, prompt_delta_appendix: "Every turn rule" });
    expect(pg.query("SELECT instructions, delta_instructions FROM multiremi_projects WHERE id = ?").get(project.id))
      .toEqual({ instructions: "Bootstrap rule\n\nDelta rule", delta_instructions: "" });

    const agent = store.createAgent({ name: "PG notes", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "你好" });
    const sha256 = createHash("sha256").update("你好").digest("hex");
    expect(store.recordTaskPrompt(task.id, { mode: "bootstrap", prompt: "你好", sha256, instructions: "# Remi\nNotes." }))
      .toMatchObject({ prompt: "你好", instructions: "# Remi\nNotes." });
    expect(store.getTaskPrompt(task.id)).toMatchObject({ instructions: "# Remi\nNotes." });
  });
});
