import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import {
  estimateProjectionTokens,
  resolveProjectionTokenBudget,
} from "@multiremi/store/session-projection-budget.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";

const projectionEnvKeys = [
  "MULTIREMI_SESSION_PROJECTION_BUDGET_SHARE",
  "MULTIREMI_SESSION_PROJECTION_CONTEXT_WINDOWS",
  "MULTIREMI_SESSION_PROJECTION_EVENT_BODY_MAX_CHARS",
  "MULTIREMI_SESSION_PROJECTION_MIN_TOKENS",
] as const;

afterEach(() => {
  for (const key of projectionEnvKeys) delete process.env[key];
});

describe("bounded Session projections", () => {
  it("preserves a body larger than the fallback cap byte-for-byte when the projection fits", () => {
    const body = `full body:${"x".repeat(9_000)}`;
    const projection = buildSessionProjection({
      sessionId: "ises_1",
      targetAgentId: "agt_target",
      events: [event(1, "message", body, { z: 1, a: 2 })],
      cursorSeq: 0,
      providerSessionId: null,
      tokenBudget: 10_000,
      resolveAuthorName: () => "Teammate",
    });

    expect(projection.jsonl).toBe([
      '{"type":"session_projection","version":1,"mode":"bootstrap","session_id":"ises_1","target_agent_id":"agt_target","from_seq":0,"to_seq":1}',
      JSON.stringify({
        type: "session_event",
        seq: 1,
        kind: "message",
        perspective: "user",
        author_type: "member",
        author_id: "usr_1",
        author_name: "Teammate",
        body,
        task_id: null,
        source_comment_id: "cmt_1",
        metadata: { a: 2, z: 1 },
        created_at: "2026-08-28T00:00:00.000Z",
      }),
    ].join("\n"));
    expect(projection.jsonl).not.toContain("body_truncated");
    expect(projection).toMatchObject({
      truncated: false,
      omittedEvents: 0,
      estimatedTokens: estimateProjectionTokens(projection.jsonl),
    });
  });

  it("keeps published results and recent events while marking elided ranges in sequence order", () => {
    const events = Array.from({ length: 10 }, (_, index) => event(
      index + 1,
      index === 2 ? "result_published" : "message",
      `${index + 1}:` + "x".repeat(1_000),
    ));
    const projection = buildSessionProjection({
      sessionId: "ises_priority",
      targetAgentId: "agt_target",
      events,
      cursorSeq: 0,
      providerSessionId: null,
      tokenBudget: 1_200,
    });
    const lines = projection.jsonl.split("\n").map((line) => JSON.parse(line));
    const projectedEvents = lines.filter((line) => line.type === "session_event");
    const elisions = lines.filter((line) => line.type === "session_elision");

    expect(projection.truncated).toBe(true);
    expect(projection.omittedEvents).toBeGreaterThan(0);
    expect(projection.estimatedTokens).toBeLessThanOrEqual(1_200);
    expect(projectedEvents.some((line) => line.seq === 3 && line.kind === "result_published")).toBe(true);
    expect(projectedEvents.at(-1)?.seq).toBe(10);
    expect(elisions.length).toBeGreaterThan(0);
    expect(elisions.every((line) => line.omitted_events > 0 && line.omitted_chars > 0)).toBe(true);
    const positions = lines.slice(1).map((line) => line.type === "session_event" ? line.seq : line.from_seq);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("hard-truncates a single giant body until the assembled JSONL fits", () => {
    const projection = buildSessionProjection({
      sessionId: "ises_giant",
      targetAgentId: "agt_target",
      events: [event(1, "message", "巨".repeat(50_000))],
      cursorSeq: 0,
      providerSessionId: null,
      tokenBudget: 400,
    });
    const rendered = JSON.parse(projection.jsonl.split("\n")[1]!);

    expect(rendered.body_truncated).toBe(true);
    expect(rendered.body_omitted_chars).toBeGreaterThan(0);
    expect(projection.truncated).toBe(true);
    expect(projection.omittedEvents).toBe(0);
    expect(projection.estimatedTokens).toBeLessThanOrEqual(400);
    expect(estimateProjectionTokens(projection.jsonl)).toBeLessThanOrEqual(400);
  });

  it("resolves each author identity once across repeated fallback assemblies", () => {
    let resolverCalls = 0;
    const events = Array.from({ length: 320 }, (_, index) => ({
      ...event(index + 1, "message", "中".repeat(200)),
      authorId: index % 2 === 0 ? "usr_1" : "usr_2",
    }));
    const projection = buildSessionProjection({
      sessionId: "ises_cached_authors",
      targetAgentId: "agt_target",
      events,
      cursorSeq: 0,
      providerSessionId: null,
      tokenBudget: 1_200,
      resolveAuthorName: (_authorType, authorId) => {
        resolverCalls += 1;
        return authorId;
      },
    });

    expect(resolverCalls).toBe(2);
    expect(projection.truncated).toBe(true);
    expect(projection.estimatedTokens).toBeLessThanOrEqual(1_200);
  });

  it("drops older published results with an explicit count when the pinned set exceeds budget", () => {
    const events = [
      ...Array.from({ length: 120 }, (_, index) => event(
        index + 1,
        "result_published",
        `result ${index + 1}:${"x".repeat(500)}`,
      )),
      event(121, "message", "latest event"),
    ];
    const projection = buildSessionProjection({
      sessionId: "ises_many_results",
      targetAgentId: "agt_target",
      events,
      cursorSeq: 0,
      providerSessionId: null,
      tokenBudget: 4_096,
    });
    const lines = projection.jsonl.split("\n").map((line) => JSON.parse(line));
    const projectedEvents = lines.filter((line) => line.type === "session_event");
    const elisions = lines.filter((line) => line.type === "session_elision");
    const omittedPublishedResults = elisions.reduce(
      (count, line) => count + (line.omitted_published_results ?? 0),
      0,
    );

    expect(projection.estimatedTokens).toBeLessThanOrEqual(4_096);
    expect(projectedEvents.at(-1)?.seq).toBe(121);
    expect(projectedEvents.some((line) => line.seq === 120 && line.kind === "result_published")).toBe(true);
    expect(omittedPublishedResults).toBeGreaterThan(0);
    expect(omittedPublishedResults).toBe(120 - projectedEvents.filter(
      (line) => line.kind === "result_published",
    ).length);
  });

  it("resolves an overrideable model budget and halves it at each degrade level", () => {
    process.env.MULTIREMI_SESSION_PROJECTION_CONTEXT_WINDOWS = JSON.stringify({ default: 100_000 });
    process.env.MULTIREMI_SESSION_PROJECTION_BUDGET_SHARE = "0.4";
    process.env.MULTIREMI_SESSION_PROJECTION_MIN_TOKENS = "100";

    expect(resolveProjectionTokenBudget({ provider: "unknown", model: null, degradeLevel: 0 })).toBe(40_000);
    expect(resolveProjectionTokenBudget({ provider: "unknown", model: null, degradeLevel: 1 })).toBe(20_000);
    expect(resolveProjectionTokenBudget({ provider: "unknown", model: null, degradeLevel: 2 })).toBe(10_000);
    expect(estimateProjectionTokens("中文ab")).toBe(3);
  });
});

function event(
  seq: number,
  kind: string,
  body: string,
  metadata: Record<string, unknown> = {},
): MultiremiSessionEvent {
  return {
    id: `sevt_${seq}`,
    sessionId: "ises_1",
    seq,
    authorType: "member",
    authorId: "usr_1",
    kind,
    body,
    taskId: null,
    sourceCommentId: `cmt_${seq}`,
    metadata,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}
