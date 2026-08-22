import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dir, "../..");

function readWorkflow(name: string): Record<string, any> {
  return parse(readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8"));
}

describe("release workflows", () => {
  test("publishes the platform automatically after the tag release", () => {
    const release = readWorkflow("release.yml");
    expect(release.on.push.tags).toContain("v*");
    expect(release.jobs.platform.needs).toBe("release");
    expect(release.jobs.platform.uses).toBe("./.github/workflows/platform-release.yml");
    expect(release.jobs.platform.with.tag).toBe("${{ github.ref_name }}");
    expect(release.jobs.platform.permissions.packages).toBe("write");
    expect(release.jobs.platform.permissions.attestations).toBe("write");
  });

  test("keeps platform publication manually recoverable and source-bound", () => {
    const platform = readWorkflow("platform-release.yml");
    expect(platform.on.workflow_call.inputs.tag.type).toBe("string");
    expect(platform.on.workflow_dispatch.inputs.tag.type).toBe("string");

    const serialized = JSON.stringify(platform);
    expect(serialized).toContain("remi-api:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("remi-web:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("steps.images.outputs.api_digest");
    expect(serialized).toContain("steps.images.outputs.web_digest");
    expect(serialized).toContain("--clobber");
  });
});
