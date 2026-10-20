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
});
