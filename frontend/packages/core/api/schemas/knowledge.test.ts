import { describe, expect, it } from "vitest";
import {
  KnowledgeRunDetailSchema,
  ListKnowledgeRunsResponseSchema,
  ListKnowledgeSubmissionsResponseSchema,
} from "./knowledge";

const submission = {
  id: "ksub_1",
  scope: "memory",
  source_type: "agent",
  status: "pending",
};

const run = {
  id: "krun_1",
  mode: "memory_curate",
  status: "published",
};

describe("knowledge response schemas", () => {
  it("keeps valid legacy Raw rows and defaults every missing provenance field", () => {
    const parsed = ListKnowledgeSubmissionsResponseSchema.parse({
      submissions: [submission, { scope: "memory" }],
    });

    expect(parsed.submissions).toHaveLength(1);
    expect(parsed.submissions[0]).toMatchObject({
      id: "ksub_1",
      project_id: null,
      source_issue: null,
      author_agent: null,
      source_task: null,
      body: "",
    });
  });

  it("accepts the first-phase flat run list and degrades missing relationships to empty arrays", () => {
    const parsed = ListKnowledgeRunsResponseSchema.parse({ runs: [run] });

    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]).toMatchObject({
      run: { id: "krun_1", agent: null },
      sources: [],
      outputs: [],
    });
  });

  it("preserves relationships added to the backward-compatible flat run list", () => {
    const parsed = ListKnowledgeRunsResponseSchema.parse({
      runs: [{
        ...run,
        sources: [{ id: "ksrc_1", submission_id: "ksub_1", submission }],
        outputs: [{ id: "kout_1", artifact_scope: "memory", action: "create" }],
      }],
    });

    expect(parsed.runs[0]).toMatchObject({
      run: { id: "krun_1" },
      sources: [{ id: "ksrc_1", submission: { id: "ksub_1" } }],
      outputs: [{ id: "kout_1", artifact_scope: "memory" }],
    });
  });

  it("preserves unknown server enums and drops malformed relationship decorations", () => {
    const parsed = KnowledgeRunDetailSchema.parse({
      run: { ...run, status: "future_terminal_state" },
      sources: null,
      outputs: [{
        id: "kout_1",
        action: "future_action",
        artifact_scope: "memory",
        artifact: { id: 42 },
      }],
    });

    expect(parsed.run.status).toBe("future_terminal_state");
    expect(parsed.sources).toEqual([]);
    expect(parsed.outputs[0]).toMatchObject({
      action: "future_action",
      artifact: null,
      version: null,
    });
  });

  it("turns null list payloads into empty lists instead of throwing into the UI", () => {
    expect(ListKnowledgeSubmissionsResponseSchema.parse({ submissions: null })).toEqual({
      submissions: [],
    });
    expect(ListKnowledgeRunsResponseSchema.parse({ runs: null })).toEqual({ runs: [] });
  });
});
