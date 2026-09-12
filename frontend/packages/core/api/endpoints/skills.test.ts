import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { SkillsEndpoints } from "./skills";
import { RuntimesEndpoints } from "./runtimes";

const binaryFile = { id: "file-1", skill_id: "skill-1", path: "assets/pixel.png", content: "iVBORw0KGgoA/w==", encoding: "base64" as const, created_at: "now", updated_at: "now" };
const skill = { id: "skill-1", workspace_id: "ws-1", name: "Review", description: "Review code", content: "# Review", config: {}, created_by: "user-1", created_at: "now", updated_at: "now", files: [binaryFile] };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const api = () => new SkillsEndpoints(new HttpClient("https://api.example.test"));
afterEach(() => vi.unstubAllGlobals());

describe("Skill binary attachment boundary", () => {
  it("preserves encoding and content through detail reads and edits", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response(skill)));
    vi.stubGlobal("fetch", fetch);
    await expect(api().getSkill("skill-1")).resolves.toEqual(skill);
    const payload = { name: "Renamed", files: [{ path: binaryFile.path, content: binaryFile.content, encoding: binaryFile.encoding }] };
    await expect(api().updateSkill("skill-1", payload)).resolves.toEqual(skill);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual(payload);
    await expect(api().createSkill(payload)).resolves.toEqual(skill);
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual(payload);
    await expect(api().importSkill({ url: "https://example.test/skill" })).resolves.toEqual(skill);
  });

  it("preserves binary attachments returned by a Runtime import", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ id: "import-1", runtime_id: "runtime-1", skill_key: "review", status: "completed", skill, created_at: "now", updated_at: "now" })));
    const runtimes = new RuntimesEndpoints(new HttpClient("https://api.example.test"));
    await expect(runtimes.getImportLocalSkillResult("runtime-1", "import-1")).resolves.toMatchObject({ skill });
  });

  it("accepts legacy UTF8 files without an encoding", async () => {
    const textFile = { ...binaryFile, path: "notes.txt", content: "hello", encoding: undefined };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...skill, files: [textFile] })));
    await expect(api().getSkill("skill-1")).resolves.toMatchObject({ files: [{ path: "notes.txt", content: "hello" }] });
  });

  it("rejects unknown encodings instead of opening them as editable text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response({ ...skill, files: [{ ...binaryFile, encoding: "hex" }] }))));
    await expect(api().getSkill("skill-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(api().updateSkill("skill-1", { description: "New description" })).rejects.toBeInstanceOf(ApiContractError);
  });
});
