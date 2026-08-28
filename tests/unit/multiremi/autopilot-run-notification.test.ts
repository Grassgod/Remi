import { describe, expect, it } from "bun:test";
import {
  autopilotOutcomeBody,
  autopilotTriggerObjectLabel,
  formatAutopilotDuration,
  summarizeAutopilotOutcome,
} from "@multiremi/store/autopilot-run-notification.js";
import type { AutopilotRunTriggerSummary } from "@multiremi/api/wire/autopilots.js";

const CHECKOUT_FAILURE_FIXTURE = await Bun.file(new URL(
  "../../fixtures/multiremi/autopilot-no-change-checkout-failure.txt",
  import.meta.url,
)).text();

function trigger(overrides: Partial<AutopilotRunTriggerSummary>): AutopilotRunTriggerSummary {
  return {
    event_type: "change.merged",
    repository_id: "repo_1",
    repository_name: "Remi",
    change_number: null,
    change_title: null,
    target_branch: null,
    source_revision: null,
    occurred_at: null,
    wiki_build: false,
    ...overrides,
  };
}

describe("autopilot run notifications", () => {
  it.each([
    "No changes were needed.",
    "Everything is already up to date.",
    "Working copy remains clean.",
    "本次无需更新。",
    "没有变化。",
  ])("recognizes no-change outcomes: %s", (value) => {
    expect(summarizeAutopilotOutcome(value)).toEqual({
      kind: "no_change",
      text: null,
      links: [],
      counts: null,
      risks: [],
      action: { kind: "none", text: null },
    });
  });

  it("does not report a real checkout failure as no-change", () => {
    const outcome = summarizeAutopilotOutcome(CHECKOUT_FAILURE_FIXTURE);

    expect(outcome.kind).toBe("unknown");
    expect(outcome.text).not.toBeNull();
    expect(outcome.risks.length).toBeGreaterThan(0);
    expect(outcome.risks[0]).toContain("无法检出");
    expect(outcome.action).toEqual({
      kind: "investigate",
      text: outcome.risks[0],
    });
  });

  it("extracts pull request and merge request links with counts", () => {
    const outcome = summarizeAutopilotOutcome([
      "Created https://github.com/Grassgod/Remi/pull/123.",
      "See https://code.byted.org/taoze/personal_automation/merge_requests/45 for the other change.",
    ].join("\n"));
    expect(outcome).toMatchObject({
      kind: "changes",
      links: [
        { kind: "pull_request", url: "https://github.com/Grassgod/Remi/pull/123", number: 123 },
        { kind: "merge_request", url: "https://code.byted.org/taoze/personal_automation/merge_requests/45", number: 45 },
      ],
      counts: { changes: 2, pull_requests: 1, merge_requests: 1 },
      risks: [],
      action: { kind: "review", text: null },
    });
    expect(autopilotOutcomeBody(outcome, 12)).toBe(
      "Completed in 12s | Created 2 changes: https://github.com/Grassgod/Remi/pull/123, https://code.byted.org/taoze/personal_automation/merge_requests/45. | Action: Review the linked change.",
    );
  });

  it("takes complete sentences from the tail without starting mid-sentence", () => {
    const longSentence = `${"Earlier context ".repeat(30).trim()}.`;
    const outcome = summarizeAutopilotOutcome(`${longSentence} Published three pages. No blockers remain.`);
    expect(outcome.text).toBe("Published three pages. No blockers remain.");
    expect(outcome.text).toMatch(/[.!?。！？]$/u);
    expect(outcome.text!.length).toBeLessThanOrEqual(240);
  });

  it("keeps an overlong unpunctuated summary from its beginning", () => {
    const summary = `Published ${"repository documentation ".repeat(20).trim()}`;
    const outcome = summarizeAutopilotOutcome(summary);

    expect(outcome.kind).toBe("unknown");
    expect(outcome.text).not.toBeNull();
    expect(outcome.text).toStartWith("Published repository documentation");
    expect(outcome.text).toEndWith("…");
    expect(Array.from(outcome.text!).length).toBeLessThanOrEqual(240);
  });

  it("folds soft line breaks before splitting sentences", () => {
    const outcome = summarizeAutopilotOutcome("Published wiki pages and\nupdated indexes");

    expect(outcome).toMatchObject({
      kind: "unknown",
      text: "Published wiki pages and updated indexes.",
    });
    expect(outcome.text).not.toContain("and. updated");
  });

  it("keeps plain text as an unknown outcome without claiming a change", () => {
    const outcome = summarizeAutopilotOutcome("Published the repository wiki update successfully.");

    expect(outcome).toEqual({
      kind: "unknown",
      text: "Published the repository wiki update successfully.",
      links: [],
      counts: null,
      risks: [],
      action: { kind: "none", text: null },
    });
    expect(autopilotOutcomeBody(outcome, 8)).toBe(
      "Completed in 8s | Published the repository wiki update successfully.",
    );
  });

  it("drops process narration before choosing the final result", () => {
    const outcome = summarizeAutopilotOutcome(
      "Good, the files match. Now let's inspect the manifest. Checking repository status. Published the wiki update. No blockers.",
    );
    expect(outcome.text).toBe("Published the wiki update. No blockers.");
  });

  it("returns unknown for empty or narration-only input", () => {
    expect(summarizeAutopilotOutcome("  ")).toEqual({
      kind: "unknown",
      text: null,
      links: [],
      counts: null,
      risks: [],
      action: { kind: "none", text: null },
    });
    expect(summarizeAutopilotOutcome("Let me check\nNext, inspect the repository").kind).toBe("unknown");
  });

  it("forces cleaned failures to the failed kind", () => {
    const outcome = summarizeAutopilotOutcome("Dependency service unavailable", { failed: true });
    expect(outcome).toMatchObject({
      kind: "failed",
      text: "Dependency service unavailable.",
      risks: [],
      action: {
        kind: "investigate",
        text: "Dependency service unavailable.",
      },
    });
    expect(autopilotOutcomeBody(outcome, 60)).toBe(
      "Failed after 1m | Dependency service unavailable. | Action: Investigate this run. Dependency service unavailable.",
    );
  });

  it("recommends retrying transient provider failures", () => {
    const outcome = summarizeAutopilotOutcome(
      "503 No available accounts: provider capacity exhausted.",
      { failed: true },
    );

    expect(outcome.action).toEqual({
      kind: "retry",
      text: "503 No available accounts: provider capacity exhausted.",
    });
  });

  it("limits risks to three complete, bounded sentences", () => {
    const outcome = summarizeAutopilotOutcome([
      "Unable to check out the repository.",
      `Permission denied while reading ${"a very long repository path ".repeat(10).trim()}.`,
      "The validation failed before completion.",
      "Manual review is required.",
    ].join(" "));

    expect(outcome.risks).toHaveLength(3);
    for (const risk of outcome.risks) {
      expect(Array.from(risk).length).toBeLessThanOrEqual(160);
      expect(risk).toMatch(/[.!?。！？…]$/u);
    }
  });

  it("formats duration boundaries for external notification bodies", () => {
    expect(formatAutopilotDuration(59)).toBe("59s");
    expect(formatAutopilotDuration(60)).toBe("1m");
    expect(formatAutopilotDuration(3515)).toBe("58m");
    expect(formatAutopilotDuration(7200)).toBe("2h 0m");
  });

  it("builds repository, branch, change, and schedule trigger labels", () => {
    expect(autopilotTriggerObjectLabel(trigger({}), "scm_event", "2026-08-27T09:00:00Z")).toBe("Remi");
    expect(autopilotTriggerObjectLabel(trigger({ target_branch: "main" }), "scm_event", "2026-08-27T09:00:00Z"))
      .toBe("Remi@main");
    expect(autopilotTriggerObjectLabel(trigger({ change_number: 123, target_branch: "main" }), "scm_event", "2026-08-27T09:00:00Z"))
      .toBe("Remi #123");
    expect(autopilotTriggerObjectLabel(trigger({ repository_id: null, repository_name: null, event_type: "schedule" }), "schedule", "2026-08-27T09:00:00Z"))
      .toBe("Scheduled 09:00 UTC");
    expect(autopilotTriggerObjectLabel(null, "manual", "2026-08-27T09:00:00Z")).toBeNull();
  });
});
