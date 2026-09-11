import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { RuntimesEndpoints } from "./runtimes";

const request = { id: "scan-1", runtime_id: "runtime-1", status: "completed", supported: true, created_at: "now", updated_at: "now" };
const skill = { key: "review", name: "Review", source_path: "/skills/review", provider: "codex", file_count: 1 };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const api = () => new RuntimesEndpoints(new HttpClient("https://api.example.test"));

afterEach(() => vi.unstubAllGlobals());

describe("Runtime local skill API boundary", () => {
  it("sends the requested root and retains inventory errors and scan warnings", async () => {
    const result = { ...request, root: "/skills", skills: [{ ...skill, error: "Bundle too large" }], warnings: ["Scan limit reached"] };
    const fetch = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal("fetch", fetch);
    await expect(api().initiateListLocalSkills("runtime-1", { root: "~/.agents/skills" })).resolves.toEqual(result);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ root: "~/.agents/skills" });
  });

  it("accepts an empty inventory omitted by existing servers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(request)));
    await expect(api().getListLocalSkillsResult("runtime-1", "scan-1")).resolves.toEqual(request);
  });

  it.each([
    { ...request, id: undefined },
    { ...request, id: "" },
    { ...request, status: "unexpected" },
    { ...request, skills: "not an array" },
    { ...request, skills: [{ ...skill, file_count: "1" }] },
    { ...request, warnings: "Incomplete" },
    { ...request, root: 42 },
  ])("rejects malformed discovery responses instead of exposing an importable scan", async body => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response(body))));
    await expect(api().initiateListLocalSkills("runtime-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(api().getListLocalSkillsResult("runtime-1", "scan-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("binds imports to the selected scan and rejects completion without a usable skill", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ...request, id: "import-1", status: "pending", skill_key: "review" }));
    vi.stubGlobal("fetch", fetch);
    const payload = { scan_request_id: "scan-1", skill_key: "review" };
    await expect(api().initiateImportLocalSkill("runtime-1", payload)).resolves.toMatchObject({ status: "pending" });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(payload);
    fetch.mockResolvedValueOnce(response({ ...request, skill_key: "review" }));
    await expect(api().getImportLocalSkillResult("runtime-1", "import-1")).rejects.toBeInstanceOf(ApiContractError);
    fetch.mockResolvedValueOnce(response({ ...request, skill_key: "review", skill: { id: "skill-1", files: "invalid" } }));
    await expect(api().getImportLocalSkillResult("runtime-1", "import-1")).rejects.toBeInstanceOf(ApiContractError);
  });
});
