import { describe, expect, it } from "bun:test";
import {
  buildScmLogicalKey,
  reconcileObservation,
  stableJsonHash,
} from "@multiremi/scm/reconcile.js";
import type { ScmEntityObservation } from "@multiremi/scm/types.js";
import { MemoryScmIngestionStore, scmBinding } from "./scm-test-helpers.js";

const observedAt = "2026-08-21T08:00:00.000Z";

function changeObservation(state: string, version: string): ScmEntityObservation {
  return {
    stream: "change_requests",
    entityType: "change_request",
    externalId: "9001",
    version,
    occurredAt: version,
    observedAt,
    payload: {
      id: "9001",
      number: 42,
      state,
      title: "Ship it",
      head_sha: `sha-${version}`,
      updated_at: version,
      merged_at: state === "merged" ? version : null,
    },
  };
}

describe("SCM reconciliation", () => {
  it("writes a baseline without creating historical events", () => {
    const store = new MemoryScmIngestionStore();
    const first = reconcileObservation({
      store,
      binding: scmBinding(),
      observation: changeObservation("open", "2026-08-20T01:00:00.000Z"),
      baseline: true,
    });
    expect(first.changed).toBe(true);
    expect(first.events).toHaveLength(0);
    expect(store.snapshots.size).toBe(1);
  });

  it("derives state transitions and deduplicates logical events across evidence sources", () => {
    const store = new MemoryScmIngestionStore();
    const binding = scmBinding();
    reconcileObservation({ store, binding, observation: changeObservation("open", "2026-08-20T01:00:00.000Z"), baseline: true });
    const merged = changeObservation("merged", "2026-08-21T07:59:00.000Z");
    const poll = reconcileObservation({ store, binding, observation: merged, baseline: false, source: "poll" });
    expect(poll.events).toHaveLength(1);
    expect(poll.events[0]?.event.type).toBe("change.merged");
    expect(poll.events[0]?.event.fidelity).toBe("inferred");

    const candidate = {
      type: "change.merged" as const,
      subjectType: "change_request",
      subjectId: "9001",
      logicalVersion: `${merged.version}:merged`,
      occurredAt: merged.occurredAt,
      payload: merged.payload,
    };
    expect(buildScmLogicalKey(binding.repositoryId, candidate)).toBe(poll.events[0]?.event.logicalKey);
  });

  it("emits both push and default-branch events when the head changes", () => {
    const store = new MemoryScmIngestionStore();
    const binding = scmBinding();
    const first: ScmEntityObservation = {
      stream: "default_branch", entityType: "ref", externalId: "main", version: "aaa",
      occurredAt: observedAt, observedAt, payload: { branch: "main", head_sha: "aaa" },
    };
    reconcileObservation({ store, binding, observation: first, baseline: true });
    const second = { ...first, version: "bbb", payload: { branch: "main", head_sha: "bbb" } };
    const result = reconcileObservation({ store, binding, observation: second, baseline: false });
    expect(result.events.map((entry) => entry.event.type)).toEqual(["default_branch.updated", "push.observed"]);
  });

  it("hashes JSON objects independently of key insertion order", () => {
    expect(stableJsonHash({ b: 2, a: { z: 1, y: true } })).toBe(
      stableJsonHash({ a: { y: true, z: 1 }, b: 2 }),
    );
  });
});

