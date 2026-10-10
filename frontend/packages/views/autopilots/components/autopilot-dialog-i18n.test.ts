import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { createI18n } from "@multiremi/core/i18n/react";
import enAutopilots from "../../locales/en/autopilots.json";
import zhAutopilots from "../../locales/zh-Hans/autopilots.json";
import { formatSchedulePartialFailureToast } from "./autopilot-dialog-toast";

// Contract test for the autopilot-dialog partial-success toast formatting.
//
// The dialog routes its partial-success branches through
// `formatSchedulePartialFailureToast`, so this test drives that exact
// helper rather than calling `t(...)` independently. That means a regression
// in either side — the JSON template (e.g. `{reason}` instead of `{{reason}}`)
// or the call-site variable name (e.g. `{ msg: ... }` instead of
// `{ reason: ... }`) — fails this test with the substring assertion.

describe("autopilot dialog partial-success toast", () => {
  const reason = "schedule conflict: 09:00 overlaps existing trigger";

  describe.each([
    ["en", { en: { autopilots: enAutopilots } }],
    ["zh-Hans", { "zh-Hans": { autopilots: zhAutopilots }, en: { autopilots: enAutopilots } }],
  ] as const)("%s", (locale, resources) => {
    const i18n = createI18n(locale, resources);
    const t = i18n.getFixedT(locale, "autopilots") as TFunction<"autopilots">;

    it.each(["create", "update"] as const)("renders %s partial-success with the server reason verbatim", mode => {
      const rendered = formatSchedulePartialFailureToast(t, mode, reason);
      expect(rendered).toContain(reason);
      expect(rendered).not.toContain("{{");
      expect(rendered).not.toContain("{reason}");
    });
    if (locale === "en") {
      it.each([
        ["create", "Autopilot created, but schedule failed to save"],
        ["update", "Autopilot updated, but schedule failed to save"],
      ] as const)("falls back to the no-reason %s string when reason is null", (mode, expected) => {
        expect(formatSchedulePartialFailureToast(t, mode, null)).toBe(expected);
      });
    }
  });
});
