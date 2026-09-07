import { describe, expect, it } from "vitest";
import { AutopilotTriggerSchema, AutopilotRunSchema, EMPTY_AUTOPILOT_TRIGGER, EMPTY_AUTOPILOT_RUN } from "./autopilots";

describe("scheduled target response compatibility", () => {
  it("keeps older and malformed responses usable", () => {
    expect(AutopilotTriggerSchema.parse(EMPTY_AUTOPILOT_TRIGGER).schedule_targets).toBeNull();
    expect(AutopilotTriggerSchema.parse({ ...EMPTY_AUTOPILOT_TRIGGER, schedule_targets: { projects: null } }).schedule_targets).toBeNull();
    expect(AutopilotRunSchema.parse({ ...EMPTY_AUTOPILOT_RUN, schedule_target: { kind: "future-kind" } }).schedule_target).toBeNull();
  });
  it("preserves both kinds of selection and named queued runs", () => {
    const targets = { projects: { all: true, ids: [] }, repositories: { all: false, ids: ["repo-1"] }, prompt: "Lint" };
    expect(AutopilotTriggerSchema.parse({ ...EMPTY_AUTOPILOT_TRIGGER, schedule_targets: targets }).schedule_targets).toEqual(targets);
    expect(AutopilotRunSchema.parse({ ...EMPTY_AUTOPILOT_RUN, status: "queued", schedule_target: { kind: "project", id: "p1", name: "Remi" }, schedule_batch_id: "b1" })).toMatchObject({ status: "queued", schedule_batch_id: "b1", schedule_target: { id: "p1" } });
  });
});
