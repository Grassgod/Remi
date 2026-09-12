import { expect, it } from "bun:test";
import { advancesFeishuPresentation, parseFeishuPresentation } from "@multiremi/contracts/feishu-presentation.js";
import type { FeishuPresentationCheckpoint } from "@multiremi/contracts/types.js";

it("accepts historical checkpoints and validates optional semantic delivery markers", () => {
  const old: FeishuPresentationCheckpoint = { version: "native_cot_v1", startedAt: 1, throughSeq: 0, interactions: {} };
  expect(parseFeishuPresentation(old)).toEqual(old);
  const current: FeishuPresentationCheckpoint = { ...old, cot: { status: "creating", presentation: "semantic_v1" },
    interactions: { request: { messageId: "om_test", waitingStarted: true, waitingFinished: true } } };
  expect(parseFeishuPresentation(current)).toEqual(current);
  expect(advancesFeishuPresentation(old, current)).toBe(true);
  expect(advancesFeishuPresentation(current, { ...current, interactions: { request: { messageId: "om_test" } } })).toBe(false);
  expect(advancesFeishuPresentation(current, { ...current, cot: { status: "creating" } })).toBe(false);
  expect(parseFeishuPresentation({ ...current, cot: { status: "creating", presentation: "unknown" } })).toBeNull();
  expect(parseFeishuPresentation({ ...current, interactions: { request: { messageId: "om_test", waitingFinished: "yes" } } })).toBeNull();
});
