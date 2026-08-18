import { describe, expect, it } from "vitest";
import {
  getDefaultSystemEventConfig,
  serializeSystemEventConfig,
} from "./system-event-config";

describe("system event config", () => {
  it("defaults to completed Issues in every project", () => {
    expect(getDefaultSystemEventConfig()).toEqual({
      resource: "issue",
      event: "status_changed",
      conditions: [{ field: "status", operator: "becomes", value: "done" }],
      project_id: null,
    });
  });

  it("normalizes an omitted project scope for dirty checks", () => {
    const config = getDefaultSystemEventConfig();
    expect(serializeSystemEventConfig({ ...config, project_id: undefined })).toBe(
      serializeSystemEventConfig({ ...config, project_id: null }),
    );
  });
});
