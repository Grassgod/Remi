import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ initiateListLocalSkills: vi.fn(), getListLocalSkillsResult: vi.fn() }));
vi.mock("../api", () => ({ api }));
import { resolveRuntimeLocalSkills, runtimeLocalSkillsOptions } from "./local-skills";

const result = { id: "scan-1", status: "completed", supported: true, skills: [], root: "/skills", warnings: ["Scan limit reached"] };
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe("Runtime skill discovery", () => {
  it("retains the scan identity and resolved directory through polling", async () => {
    vi.useFakeTimers();
    api.initiateListLocalSkills.mockResolvedValue({ ...result, status: "pending" });
    api.getListLocalSkillsResult.mockResolvedValue(result);
    const pending = resolveRuntimeLocalSkills("runtime-1", "~/.agents/skills");
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ scan_request_id: "scan-1", skills: [], supported: true, root: "/skills", warnings: ["Scan limit reached"] });
    expect(api.initiateListLocalSkills).toHaveBeenCalledWith("runtime-1", { root: "~/.agents/skills" });
    expect(api.getListLocalSkillsResult).toHaveBeenCalledWith("runtime-1", "scan-1");
  });

  it.each([undefined, null, "", "~/skills", "relative/skills", "C:skills", "\\skills", "\\\\host"])("rejects custom discovery with an unresolved root: %s", async root => {
    api.initiateListLocalSkills.mockResolvedValue({ ...result, root });
    await expect(resolveRuntimeLocalSkills("runtime-1", "~/skills")).rejects.toThrow("updated Remi server and runtime");
  });

  it.each(["/Users/mac/.agents/skills", "C:\\Users\\Alice\\skills", "\\\\host\\share\\skills"])("accepts a directory resolved by the remote machine: %s", async root => {
    api.initiateListLocalSkills.mockResolvedValue({ ...result, root });
    await expect(resolveRuntimeLocalSkills("runtime-1", "~/skills")).resolves.toMatchObject({ root });
  });

  it("keeps default discovery compatible and isolates directory caches", async () => {
    api.initiateListLocalSkills.mockResolvedValue({ ...result, root: undefined, skills: undefined });
    await expect(resolveRuntimeLocalSkills("runtime-1")).resolves.toMatchObject({ skills: [], scan_request_id: "scan-1" });
    expect(runtimeLocalSkillsOptions("runtime-1", "/one").queryKey).not.toEqual(runtimeLocalSkillsOptions("runtime-1", "/two").queryKey);
  });

  it("surfaces a failed scan instead of presenting its old skills", async () => {
    api.initiateListLocalSkills.mockResolvedValue({ ...result, status: "failed", error: "Update the runtime daemon" });
    await expect(resolveRuntimeLocalSkills("runtime-1", "/skills")).rejects.toThrow("Update the runtime daemon");
  });
});
