import { expect, it } from "bun:test";
import { advancesFeishuPresentation, FEISHU_COT_PRESENTATION, parseFeishuPresentation } from "@multiremi/contracts/feishu-presentation.js";
import type { FeishuPresentationCheckpoint } from "@multiremi/contracts/types.js";

it("accepts historical checkpoints and validates optional semantic delivery markers", () => {
  const old: FeishuPresentationCheckpoint = { version: "native_cot_v1", startedAt: 1, throughSeq: 0, interactions: {} };
  expect(parseFeishuPresentation(old)).toEqual(old);
  const current: FeishuPresentationCheckpoint = { ...old, cot: { status: "creating", presentation: "items_v1" },
    interactions: { request: { messageId: "om_test", waitingStarted: true, waitingFinished: true } } };
  expect(parseFeishuPresentation(current)).toEqual(current);
  expect(advancesFeishuPresentation(old, current)).toBe(true);
  expect(advancesFeishuPresentation(current, { ...current, interactions: { request: { messageId: "om_test" } } })).toBe(false);
  expect(advancesFeishuPresentation(current, { ...current, cot: { status: "creating" } })).toBe(false);
  expect(parseFeishuPresentation({ ...current, cot: { status: "creating", presentation: "unknown" } })).toBeNull();
  expect(parseFeishuPresentation({ ...current, interactions: { request: { messageId: "om_test", waitingFinished: "yes" } } })).toBeNull();
});

it("still parses an earlier renderer's tag so its active CoT can be closed once, and never retags it", () => {
  const earlier: FeishuPresentationCheckpoint = { version: "native_cot_v1", startedAt: 1, throughSeq: 4, interactions: {},
    cot: { status: "active", presentation: "semantic_v1", cotId: "cot_old", messageId: "om_old", runStarted: true } };
  expect(parseFeishuPresentation(earlier)).toEqual(earlier);
  expect(FEISHU_COT_PRESENTATION).toBe("items_v1");
  // The upgrade path disables the old display and keeps its tag and handle.
  expect(advancesFeishuPresentation(earlier, { ...earlier,
    cot: { ...earlier.cot!, status: "disabled", error: "legacy_cot_closed_on_upgrade" } })).toBe(true);
  expect(advancesFeishuPresentation(earlier, { ...earlier, cot: { ...earlier.cot!, presentation: "items_v1" } })).toBe(false);
});
