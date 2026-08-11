import { describe, expect, it } from "vitest";
import { ListProjectsResponseSchema, ProjectSchema } from "./projects";

const project = {
  id: "project-1",
  workspace_id: "workspace-1",
  title: "Knowledge",
  description: null,
  icon: null,
  status: "in_progress",
  priority: "none",
  lead_type: "member",
  lead_id: "user-1",
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
  issue_count: 4,
  done_count: 1,
  resource_count: 2,
};

describe("ProjectSchema", () => {
  it("keeps a current active project active", () => {
    expect(ProjectSchema.parse({ ...project, archived_at: null }).archived_at).toBeNull();
  });

  it("maps legacy completed and cancelled rows into the archive", () => {
    expect(ProjectSchema.parse({ ...project, status: "cancelled" }).archived_at)
      .toBe(project.updated_at);
    expect(ProjectSchema.parse({ ...project, status: "completed" }).archived_at)
      .toBe(project.updated_at);
  });

  it("does not infer archive state from legacy status when archived_at is explicit", () => {
    expect(ProjectSchema.parse({
      ...project,
      status: "cancelled",
      archived_at: null,
    }).archived_at).toBeNull();
  });

  it("rejects rows without stable identity fields", () => {
    expect(ProjectSchema.safeParse({ title: "Missing id" }).success).toBe(false);
  });

  it("parses the default assignee and defaults it to null on older servers", () => {
    const parsed = ProjectSchema.parse({
      ...project,
      default_assignee_type: "squad",
      default_assignee_id: "sqd_1",
    });
    expect(parsed.default_assignee_type).toBe("squad");
    expect(parsed.default_assignee_id).toBe("sqd_1");

    // A server predating the field omits it entirely.
    const legacy = ProjectSchema.parse(project);
    expect(legacy.default_assignee_type).toBeNull();
    expect(legacy.default_assignee_id).toBeNull();
  });

  it("downgrades an unknown default assignee type instead of failing the row", () => {
    const parsed = ProjectSchema.parse({
      ...project,
      default_assignee_type: "hologram",
      default_assignee_id: "hol_1",
    });
    expect(parsed.default_assignee_type).toBeNull();
  });
});

describe("ListProjectsResponseSchema", () => {
  it("parses the archive field on every row", () => {
    const parsed = ListProjectsResponseSchema.parse({
      projects: [{ ...project, archived_at: "2026-08-10T01:00:00.000Z" }],
      total: 1,
    });
    expect(parsed.projects[0]?.archived_at).toBe("2026-08-10T01:00:00.000Z");
  });
});
