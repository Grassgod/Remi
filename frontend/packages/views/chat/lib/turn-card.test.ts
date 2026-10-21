import { describe, expect, it } from "vitest";
import { turnOutcomeShown, type TurnLogRow } from "./turn-card";

const turn = { taskId: "att-2", turnId: "turn-1" };
const card = (metadata: Record<string, unknown>, taskId = "att-2"): TurnLogRow =>
  ({ id: "turn-1", kind: "turn", task_id: taskId, metadata: { turn_id: "turn-1", ...metadata } });
const reply = (fields: Partial<TurnLogRow> = {}): TurnLogRow =>
  ({ id: "reply-1", kind: "message", message_kind: "reply", task_id: "turn-1", ...fields });

describe("turnOutcomeShown", () => {
  it("needs the attempt's terminal card and the reply row it names", () => {
    const done = card({ status: "completed", final_entry_id: "reply-1" });
    expect(turnOutcomeShown([done], turn)).toBe(false);
    expect(turnOutcomeShown([done, reply()], turn)).toBe(true);
    expect(turnOutcomeShown([done, reply({ deleted_at: "2026-10-20T00:00:00Z" })], turn)).toBe(false);
    expect(turnOutcomeShown([card({ status: "running", final_entry_id: "reply-1" }), reply()], turn)).toBe(false);
  });

  it("takes a failed or cancelled card, or one that names no reply, as the outcome itself", () => {
    expect(turnOutcomeShown([card({ status: "failed", final_entry_id: "reply-1" })], turn)).toBe(true);
    expect(turnOutcomeShown([card({ status: "cancelled", final_entry_id: null })], turn)).toBe(true);
    expect(turnOutcomeShown([card({ status: "completed" })], turn)).toBe(true);
    // An older card without a status is terminal once it carries its elapsed time.
    expect(turnOutcomeShown([{ id: "legacy", kind: "turn", task_id: "att-2", metadata: { elapsed_ms: 10 } }], turn)).toBe(true);
  });

  it("reads the turn's reply row only when asked to and no card of the turn is in the window", () => {
    expect(turnOutcomeShown([reply()], turn)).toBe(false);
    expect(turnOutcomeShown([reply()], turn, true)).toBe(true);
    expect(turnOutcomeShown([reply({ message_kind: "decision" })], turn, true)).toBe(false);
    expect(turnOutcomeShown([reply()], { taskId: "att-2", turnId: null }, true)).toBe(false);
    // A retry: the failed attempt's card and reply are in the log while the new attempt runs.
    expect(turnOutcomeShown([card({ status: "failed", final_entry_id: "reply-1" }, "att-1"), reply()], turn, true)).toBe(false);
  });

  it("takes the turn's completed reply row as the outcome without its card, running or not", () => {
    const completed = reply({ metadata: { failure_reason: null, elapsed_ms: 20_000 } });
    expect(turnOutcomeShown([completed], turn)).toBe(true);
    expect(turnOutcomeShown([completed], turn, true)).toBe(true);
    expect(turnOutcomeShown([reply({ message_kind: "final", metadata: { failure_reason: null, elapsed_ms: 20_000 } })], turn)).toBe(true);
    // The card can still be the failed attempt's when the retry's reply lands.
    expect(turnOutcomeShown([card({ status: "failed", final_entry_id: "reply-1" }, "att-1"), completed], turn)).toBe(true);
    // Another turn's reply, a deleted one, or no turn id to match is not this turn's outcome.
    expect(turnOutcomeShown([reply({ task_id: "turn-0", metadata: { failure_reason: null, elapsed_ms: 1 } })], turn)).toBe(false);
    expect(turnOutcomeShown([reply({ deleted_at: "2026-10-20T00:00:00Z", metadata: { failure_reason: null, elapsed_ms: 1 } })], turn)).toBe(false);
    expect(turnOutcomeShown([completed], { taskId: "att-2", turnId: null })).toBe(false);
    // The attempt's own terminal card still decides: the reply must be the row it names.
    expect(turnOutcomeShown([card({ status: "completed", final_entry_id: "reply-9" }), completed], turn)).toBe(false);
  });

  it("keeps a running retry live beside the failed attempt's reply row it reuses", () => {
    const failed = reply({ metadata: { failure_reason: "agent_error", elapsed_ms: 8_000 } });
    expect(turnOutcomeShown([failed], turn)).toBe(false);
    expect(turnOutcomeShown([card({ status: "running" }), failed], turn)).toBe(false);
    expect(turnOutcomeShown([card({ status: "failed", final_entry_id: "reply-1" }, "att-1"), failed], turn)).toBe(false);
    // A reply row without the completion stamp (an answer to a decision) is not the outcome either.
    expect(turnOutcomeShown([reply({ metadata: { failure_reason: null } })], turn)).toBe(false);
  });
});
