import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonClaimSkillResponse, skillFileCompatibilityResponse } from "@multiremi/api/wire/skills.js";
import type { MultiremiSkillFile } from "@multiremi/contracts/types.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const pngFile: MultiremiSkillFile = { path: "assets/diagram.png", content: pngBytes.toString("base64"), encoding: "base64" };
const textFile: MultiremiSkillFile = { path: "notes.md", content: "使用图片说明工作流程。" };

describe("Skill file encoding", () => {
  it("round-trips binary bytes and legacy text through storage and agent skill hydration", () => {
    const store = createStore();
    const skill = store.createSkill({ name: "binary skill", content: "# Skill", files: [pngFile, textFile] });
    const agent = store.createAgent({ name: "Skilled", provider: "codex" });
    store.setAgentSkills(agent.id, [skill.id!]);
    for (const files of [store.getSkill(skill.id!)!.files!, store.listSkillFiles(skill.id!), store.listAgentSkills(agent.id)[0]!.files!]) {
      expect(files[0]).toMatchObject(pngFile);
      expect(Buffer.from(files[0]!.content, "base64")).toEqual(pngBytes);
      expect(files[1]).toMatchObject(textFile);
      expect(files[1]!.encoding).toBeUndefined();
    }
    expect(daemonClaimSkillResponse(store.getSkill(skill.id!)!).files).toEqual([pngFile, textFile]);
  });

  it("preserves unknown inline file encodings for the daemon to reject instead of treating them as text", () => {
    const store = createStore();
    for (const encoding of ["binary", null, 42]) {
      const file = { ...pngFile, encoding } as unknown as MultiremiSkillFile;
      const agent = store.createAgent({
        name: `Inline ${String(encoding)}`, provider: "codex",
        skills: [{ name: "inline", content: "# Skill", files: [file] }],
      });
      const stored = store.listAgentSkills(agent.id)[0]!;
      expect(daemonClaimSkillResponse(stored).files).toEqual([{ path: file.path, content: file.content, encoding }]);
      expect(skillFileCompatibilityResponse(stored.files![0]!)).toHaveProperty("encoding", encoding);
    }
    expect(skillFileCompatibilityResponse({ ...textFile, encoding: "utf8" })).not.toHaveProperty("encoding");
  });

  it("updates file content and encoding together through every storage mutation", () => {
    const store = createStore();
    const skill = store.createSkill({ name: "changing file", content: "# Skill", files: [textFile] });
    const binary = { ...pngFile, path: textFile.path };
    expect(store.upsertSkillFile(skill.id!, binary)).toMatchObject(binary);
    expect(store.upsertSkillFile(skill.id!, { ...textFile, encoding: "utf8" }).encoding).toBeUndefined();
    expect(store.getSkill(skill.id!)!.files![0]).toMatchObject(textFile);
    expect(store.updateSkill(skill.id!, { files: [pngFile] }).files![0]).toMatchObject(pngFile);
    expect(store.upsertSkill({ id: skill.id!, name: skill.name, content: skill.content, files: [textFile] }).files![0]!.encoding).toBeUndefined();
    expect(store.upsertSkill({ id: skill.id!, name: skill.name, content: skill.content, files: [pngFile] }).files![0]).toMatchObject(pngFile);
  });

  it("rejects unknown encodings and noncanonical base64 before changing stored files", () => {
    const store = createStore();
    const skill = store.createSkill({ name: "unchanged skill", content: "Keep this", files: [textFile] });
    const invalidFiles = [
      ...["binary", "", null, 42].map((encoding) => ({ ...pngFile, encoding })),
      ...["not base64!", "aGVsbG8", "Zg==\n", "Zh==", "_w==", "Y===", 42].map((content) => ({ ...pngFile, content })),
    ] as unknown as MultiremiSkillFile[];
    for (const file of invalidFiles) {
      expect(() => store.createSkill({ name: "invalid", content: "# Skill", files: [file] })).toThrow(/Invalid (skill file encoding|base64 skill file content)/);
      expect(() => store.updateSkill(skill.id!, { content: "Do not commit this", files: [file] })).toThrow(/Invalid/);
      expect(() => store.upsertSkillFile(skill.id!, { ...file, path: textFile.path })).toThrow(/Invalid/);
      expect(store.getSkill(skill.id!)!.content).toBe("Keep this");
      expect(store.listSkillFiles(skill.id!)[0]).toMatchObject(textFile);
    }
    expect(store.listSkills()).toHaveLength(1);
    expect(store.upsertSkillFile(skill.id!, { ...pngFile, content: "" }).encoding).toBe("base64");
  });

  it("preserves the binary marker in native and compatibility APIs while omitting it for text", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    for (const [index, prefix] of ["/api/skills", "/api/multiremi/skills"].entries()) {
      const created = await app.request(prefix, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `API binary ${index}`, content: "# Skill", files: [pngFile, { ...textFile, encoding: "utf8" }] }),
      });
      expect(created.status).toBe(201);
      const response = await created.json();
      const skill = response.skill ?? response;
      expect(skill.files[0]).toMatchObject(pngFile);
      expect(skill.files[1].encoding).toBeUndefined();
      for (const detailPrefix of ["/api/skills", "/api/multiremi/skills"]) {
        const detail = await (await app.request(`${detailPrefix}/${skill.id}`)).json();
        expect((detail.skill ?? detail).files[0]).toMatchObject(pngFile);
      }
      const files = await (await app.request(`/api/skills/${skill.id}/files`)).json();
      expect(files[0]).toMatchObject(pngFile);
      const updated = await app.request(`/api/skills/${skill.id}/files`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pngFile, path: textFile.path }),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ ...pngFile, path: textFile.path });
    }
  });

  it("returns a validation error for unsupported encoding or malformed base64 in the Skills API", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const existing = store.createSkill({ name: "existing", content: "# Skill", files: [textFile] });
    for (const file of [{ ...pngFile, encoding: "binary" }, { ...pngFile, content: "%%%" }]) {
      for (const prefix of ["/api/skills", "/api/multiremi/skills"]) {
        const response = await app.request(prefix, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "invalid", content: "# Skill", files: [file] }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("Invalid");
      }
      const response = await app.request(`/api/skills/${existing.id}/files`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(file),
      });
      expect(response.status).toBe(400);
    }
    expect(store.listSkillFiles(existing.id!)).toHaveLength(1);
  });

  it("keeps encoding on runtime import reports and their stored polling responses", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Runtime", provider: "codex", workspaceId: "local" });
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/skills" });
    store.reportRuntimeLocalSkillListResult(runtime.id, scan.id, {
      status: "completed", root: "/skills", skills: [{ key: "helper", name: "helper", sourcePath: "/skills/helper", provider: "codex", fileCount: 3 }],
    });
    const imported = store.createRuntimeLocalSkillImportRequest(runtime.id, { scanRequestId: scan.id, skillKey: "helper" });
    const app = createMultiremiApp({ store });
    const report = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${imported.id}/result`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", skill: { name: "helper", content: "# Skill", source_path: "/skills/helper", files: [pngFile, textFile] } }),
    });
    expect(report.status).toBe(200);
    const response = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${imported.id}`)).json();
    expect(response.status).toBe("completed");
    expect(response.skill.files[0]).toMatchObject(pngFile);
    expect(response.skill.files[1].encoding).toBeUndefined();
    expect(store.getSkill(response.skill.id)!.files![0]).toMatchObject(pngFile);
    const reopened = new MultiremiStore(db!);
    expect(reopened.getRuntimeLocalSkillImportRequest(runtime.id, imported.id)!.skill!.files![0]).toMatchObject(pngFile);
  });

  it("migrates existing text files without changing their public response", () => {
    const store = createStore();
    const skill = store.createSkill({ name: "legacy", content: "# Legacy", files: [textFile] });
    db!.run("ALTER TABLE multiremi_skill_files DROP COLUMN encoding");
    const upgraded = new MultiremiStore(db!);
    const file = upgraded.listSkillFiles(skill.id!)[0]!;
    expect(file).toMatchObject(textFile);
    expect(file.encoding).toBeUndefined();
    expect(db!.query("SELECT encoding FROM multiremi_skill_files WHERE skill_id = ?").get(skill.id!)).toEqual({ encoding: "utf8" });
    expect(upgraded.upsertSkillFile(skill.id!, pngFile)).toMatchObject(pngFile);
  });
});
