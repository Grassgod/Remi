import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";

function event(seq: number, overrides: Partial<MultiremiSessionEvent> = {}): MultiremiSessionEvent {
  return {
    id: `sevt_${seq}`,
    sessionId: "parent",
    seq,
    authorType: "member",
    authorId: "member_a",
    kind: "message",
    body: `Message ${seq}`,
    taskId: null,
    sourceCommentId: null,
    metadata: {},
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

const baseInput = {
  sessionId: "parent",
  targetAgentId: "agent_a",
  cursorSeq: 0,
  providerSessionId: null,
  tokenBudget: 4_096,
};

// These same inputs were rendered with session-projection.ts from 06eee8c6.
// The hashes cover JSONL bytes, including header order and budget elisions.
const compatibilityEvents = [
  event(1, { authorType: "agent", authorId: "agent_a", metadata: { z: 1, nested: { b: true, a: 2 } } }),
  event(2, { kind: "task_assigned", taskId: "task_current" }),
  event(3, { authorType: "agent", authorId: "agent_a" }),
  event(4, { authorType: "agent", authorId: "agent_b", body: "x".repeat(2_000) }),
  event(5, { kind: "result_published", authorType: "system", authorId: null, body: "y".repeat(3_000) }),
  event(6, { body: "z".repeat(1_000) }),
];

describe("inherited follow projection windows", () => {
  it("bootstraps from zero independently of the provider's own warm cursor", () => {
    const projection = buildSessionProjection({
      ...baseInput,
      perspectiveMode: "inherited",
      providerSessionId: "provider_existing",
      cursorSeq: 99,
      fromSeq: 0,
      toSeq: 2,
      events: [event(3), event(2), event(1)],
    });

    expect(projection).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 2 });
    expect(lines(projection.jsonl).slice(1).map((line) => line.seq)).toEqual([1, 2]);
  });

  it("includes only events in the exclusive-from, inclusive-to inherited delta window", () => {
    const projection = buildSessionProjection({
      ...baseInput,
      perspectiveMode: "inherited",
      fromSeq: 2,
      toSeq: 4,
      events: [event(5), event(4), event(1), event(3), event(2)],
    });

    expect(projection).toMatchObject({ mode: "inherited_delta", fromSeq: 2, toSeq: 4 });
    expect(lines(projection.jsonl)[0]).toMatchObject({ mode: "inherited_delta", from_seq: 2, to_seq: 4 });
    expect(lines(projection.jsonl).slice(1).map((line) => line.seq)).toEqual([3, 4]);
  });

  it("retains the target agent's inherited events and sanitizes metadata in an incremental round", () => {
    const projection = buildSessionProjection({
      ...baseInput,
      perspectiveMode: "inherited",
      providerSessionId: "provider_existing",
      cursorSeq: 99,
      fromSeq: 1,
      events: [
        event(1),
        event(2, {
          authorType: "agent", authorId: "agent_a",
          metadata: { status: "completed", result_available: true, instructions: "old request", nested: { private: true } },
        }),
        event(3, { authorType: "agent", authorId: "agent_b" }),
        event(4),
        event(5, { authorType: "system", authorId: null }),
      ],
    });
    const rendered = lines(projection.jsonl).slice(1);

    expect(rendered.map((line) => line.seq)).toEqual([2, 3, 4, 5]);
    expect(rendered.map((line) => line.perspective)).toEqual([
      "inherited_agent", "inherited_agent", "inherited_user", "inherited_operator",
    ]);
    expect(rendered[0].metadata).toEqual({ result_available: true, status: "completed" });
    expect(projection.jsonl).not.toContain("assistant_history");
    expect(projection.jsonl).not.toContain("old request");
    expect(projection.jsonl).not.toContain("private");
  });

  it("elides an oversized delta within budget while preserving its full upper boundary", () => {
    const projection = buildSessionProjection({
      ...baseInput,
      perspectiveMode: "inherited",
      fromSeq: 10,
      toSeq: 40,
      tokenBudget: 400,
      events: Array.from({ length: 45 }, (_, index) => event(index + 1, {
        authorType: "agent", authorId: "agent_a", body: "historical context ".repeat(500),
      })),
    });

    expect(projection).toMatchObject({ mode: "inherited_delta", fromSeq: 10, toSeq: 40, truncated: true });
    expect(projection.estimatedTokens).toBeLessThanOrEqual(400);
    expect(projection.omittedEvents).toBeGreaterThan(0);
    expect(lines(projection.jsonl).some((line) => line.type === "session_elision")).toBe(true);
    expect(projection.jsonl).not.toContain("assistant_history");
    for (const line of lines(projection.jsonl).slice(1)) {
      expect(line.seq ?? line.from_seq).toBeGreaterThan(10);
      expect(line.seq ?? line.to_seq).toBeLessThanOrEqual(40);
    }
  });

  it("produces identical inherited deltas for repeated frozen-window inputs", () => {
    const input = {
      ...baseInput,
      perspectiveMode: "inherited" as const,
      fromSeq: 2,
      toSeq: 4,
      events: [event(1), event(2), event(3), event(4)],
    };
    const first = buildSessionProjection(input);
    expect(buildSessionProjection({ ...input, events: [...input.events, event(5)] })).toEqual(first);
  });

  it.each([
    { name: "bootstrap", cursorSeq: 0, providerSessionId: null, tokenBudget: 4_096, hash: "20f4cfea5125cd6d6050e77296cb91b298ef9154792d570f8310c02da0406f3c" },
    { name: "delta", cursorSeq: 2, providerSessionId: "provider_existing", tokenBudget: 4_096, hash: "40ca96be3d8e55b53a76a60f4b3363beea00926b9bcffbe186721085ba214210" },
    { name: "elided bootstrap", cursorSeq: 0, providerSessionId: null, tokenBudget: 256, hash: "50fadd6a11e1faaa319a039f162c94864c258267d56a53a2132a11923dc9f6e8" },
    { name: "elided delta", cursorSeq: 2, providerSessionId: "provider_existing", tokenBudget: 256, hash: "8b07826663e1a02178a0389aa3bbb7c7561652e61b5599290b05f0d5422ae8d5" },
  ])("preserves baseline own JSONL bytes for $name and ignores inherited fromSeq", (fixture) => {
    for (const perspectiveMode of [undefined, "own"] as const) {
      const projection = buildSessionProjection({
        ...baseInput,
        cursorSeq: fixture.cursorSeq,
        providerSessionId: fixture.providerSessionId,
        tokenBudget: fixture.tokenBudget,
        currentTaskId: "task_current",
        events: compatibilityEvents,
        perspectiveMode,
        fromSeq: 999,
      });
      expect(createHash("sha256").update(projection.jsonl).digest("hex")).toBe(fixture.hash);
    }
  });
});

function lines(jsonl: string): Array<Record<string, any>> {
  return jsonl.split("\n").map((line) => JSON.parse(line));
}
