import { describe, expect, it } from "bun:test";
import {
  autopilotOutcomeBody,
  autopilotTriggerObjectLabel,
  summarizeAutopilotOutcome,
} from "@multiremi/store/autopilot-run-notification.js";
import type { AutopilotRunTriggerSummary } from "@multiremi/api/wire/autopilots.js";

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
    });
    expect(autopilotOutcomeBody(outcome, 12)).toBe(
      "Completed in 12s | Created 2 changes: https://github.com/Grassgod/Remi/pull/123, https://code.byted.org/taoze/personal_automation/merge_requests/45.",
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
    });
    expect(summarizeAutopilotOutcome("Let me check\nNext, inspect the repository").kind).toBe("unknown");
  });

  it("forces cleaned failures to the failed kind", () => {
    expect(summarizeAutopilotOutcome("Dependency service unavailable", { failed: true })).toMatchObject({
      kind: "failed",
      text: "Dependency service unavailable.",
    });
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
