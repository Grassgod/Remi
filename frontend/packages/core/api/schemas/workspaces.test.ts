import { describe, expect, it } from "vitest";
import { WorkspaceEnvResponseSchema } from "./workspaces";

describe("WorkspaceEnvResponseSchema", () => {
  it("parses a well-formed response", () => {
    const parsed = WorkspaceEnvResponseSchema.parse({
      workspace_id: "ws_1",
      env: { GH_TOKEN: "ghp_x" },
    });
    expect(parsed.env).toEqual({ GH_TOKEN: "ghp_x" });
  });

  it("defaults a missing env map so the settings page keeps rendering", () => {
    expect(WorkspaceEnvResponseSchema.parse({ workspace_id: "ws_1" }).env).toEqual({});
  });

  it("rejects a non-string value map instead of leaking it downstream", () => {
    expect(
      WorkspaceEnvResponseSchema.safeParse({ workspace_id: "ws_1", env: { PORT: 8080 } }).success,
    ).toBe(false);
  });
});
