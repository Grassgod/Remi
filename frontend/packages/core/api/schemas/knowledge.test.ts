import { describe, expect, it } from "vitest";
import type { KnowledgeSubmissionListItem } from "../../types";
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
      // The list contract has `body_excerpt` in place of `body`/`patch`
      // (MUL-386 C.2); a missing excerpt degrades to an empty string.
      body_excerpt: "",
    });
  });

  it("keeps the list preview excerpt when the server sends one", () => {
    const parsed = ListKnowledgeSubmissionsResponseSchema.parse({
      submissions: [{ ...submission, body_excerpt: "first line of the raw body" }],
    });
    expect(parsed.submissions[0]!.body_excerpt).toBe("first line of the raw body");
  });

  it("parses a list row without requiring body or patch", () => {
    // The contract is that a list row is complete *without* `body`/`patch`: the
    // server stops reading those columns (MUL-386 C.2) and the client type
    // (`KnowledgeSubmissionListItem`) has no field for them, so validation must
    // not depend on either being present.
    //
    // The schema stays `.loose()` on purpose — the repo relies on that for
    // forward compatibility — so this asserts the required shape rather than the
    // absence of unknown keys.
    const parsed = ListKnowledgeSubmissionsResponseSchema.parse({
      submissions: [{ ...submission, body_excerpt: "preview" }],
    });
    const row = parsed.submissions[0]!;
    expect(row.body_excerpt).toBe("preview");
    // Type-level: only the list-item fields are reachable through the parsed type.
    const listItem: KnowledgeSubmissionListItem = row;
    expect(listItem.id).toBe("ksub_1");
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
