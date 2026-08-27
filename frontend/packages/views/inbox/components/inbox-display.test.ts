import { describe, expect, it } from "vitest";
import type { InboxItem } from "@multiremi/core/types";
import {
  getAutopilotRunOutcome,
  getInboxDisplayTitle,
  getQuickCreateFailureDetail,
  stripQuickCreatePrefix,
} from "./inbox-display";

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "workspace-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: "issue-1",
    title: "Issue title",
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: "2026-04-29T12:00:00Z",
    details: null,
    ...overrides,
  };
}

describe("inbox display helpers", () => {
  const localizer = {
    locale: "en",
    scheduled: (time: string) => `Scheduled ${time}`,
    repeatedRuns: (title: string, count: number) => `${title} and ${count} runs`,
  };

  it("removes legacy quick-create created prefixes from list titles", () => {
    expect(
      stripQuickCreatePrefix(
        "Created MUL-1583: Fix agent list column widths",
        "MUL-1583",
      ),
    ).toBe("Fix agent list column widths");
  });

  it("cleans quick-create success titles before rendering the inbox row", () => {
    const quickCreateItem = item({
      type: "quick_create_done",
      title: "Created MUL-1583: Fix agent list column widths",
      details: { identifier: "MUL-1583" },
    });

    expect(getInboxDisplayTitle(quickCreateItem)).toBe(
      "Fix agent list column widths",
    );
  });

  it("uses the original prompt as the failed quick-create row title", () => {
    const failedItem = item({
      type: "quick_create_failed",
      title: "Quick create failed",
      body: "agent finished without creating an issue",
      issue_id: null,
      details: {
        original_prompt: "Optimize QuickCapture UI\nand attached screenshot",
      },
    });

    expect(getInboxDisplayTitle(failedItem)).toBe(
      "Optimize QuickCapture UI and attached screenshot",
    );
  });

  it("uses the redacted failure detail for failed quick-create subtitles", () => {
    const failedItem = item({
      type: "quick_create_failed",
      body: "fallback body",
      details: { error: "CLI failed\nwith exit status 1" },
    });

    expect(getQuickCreateFailureDetail(failedItem)).toBe(
      "CLI failed with exit status 1",
    );
  });

  it("builds localized SCM trigger titles with and without branches", () => {
    const scmItem = item({
      type: "autopilot_run_completed",
      title: "legacy server title",
      details: {
        autopilot_title: "Atlas · Repository Wiki",
        trigger: "scm_event",
        trigger_object: {
          event_type: "default_branch.updated",
          repository_id: "repo-1",
          repository_name: "Remi",
          change_number: null,
          change_title: null,
          target_branch: "main",
          source_revision: null,
          occurred_at: null,
          wiki_build: false,
        },
      },
    });

    expect(getInboxDisplayTitle(scmItem, localizer)).toBe("Atlas · Repository Wiki · Remi@main");
    expect(getInboxDisplayTitle({
      ...scmItem,
      details: {
        ...scmItem.details,
        trigger_object: { ...scmItem.details!.trigger_object!, target_branch: null },
      },
    }, localizer)).toBe("Atlas · Repository Wiki · Remi");
  });

  it("prioritizes a change number over a branch", () => {
    const changeItem = item({
      type: "autopilot_run_completed",
      title: "legacy server title",
      details: {
        autopilot_title: "Docs sync",
        trigger_object: {
          event_type: "change.merged",
          repository_id: "repo-1",
          repository_name: "Remi",
          change_number: 123,
          change_title: "Improve docs",
          target_branch: "main",
          source_revision: "abc123",
          occurred_at: null,
          wiki_build: false,
        },
      },
    });

    expect(getInboxDisplayTitle(changeItem, localizer)).toBe("Docs sync · Remi #123");
  });

  it("localizes schedule time in the viewer's time zone", () => {
    const scheduledItem = item({
      type: "autopilot_run_completed",
      title: "legacy server title",
      created_at: "2026-08-27T09:00:00Z",
      details: {
        autopilot_title: "Daily summary",
        trigger: "schedule",
        triggered_at: "2026-08-27T01:00:00Z",
        trigger_object: null,
      },
    });

    expect(getInboxDisplayTitle(scheduledItem, {
      ...localizer,
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    }, 12)).toBe("Daily summary · Scheduled 09:00 and 12 runs");
  });

  it("falls back to the UTC label when schedule time formatting fails", () => {
    const scheduledItem = item({
      type: "autopilot_run_completed",
      title: "legacy server title",
      details: {
        autopilot_title: "Daily summary",
        trigger: "schedule",
        triggered_at: "2026-08-27T01:00:00Z",
        trigger_object: null,
      },
    });

    expect(getInboxDisplayTitle(scheduledItem, {
      ...localizer,
      timeZone: "not-a-time-zone",
    })).toBe("Daily summary · Scheduled 01:00 UTC");
  });

  it("falls back without appending an undefined trigger object", () => {
    const legacyItem = item({
      type: "autopilot_run_failed",
      title: "Legacy failure title",
      details: { autopilot_title: "Dependency audit" },
    });
    const unstructuredItem = item({
      type: "autopilot_run_completed",
      title: "Legacy completed title",
      details: null,
    });

    expect(getInboxDisplayTitle(legacyItem, localizer)).toBe("Dependency audit");
    expect(getInboxDisplayTitle(unstructuredItem, localizer)).toBe("Legacy completed title");
  });

  it("rejects malformed structured outcomes at the API boundary", () => {
    const malformed = item({
      type: "autopilot_run_completed",
      details: {
        outcome: {
          kind: "changes",
          text: { unexpected: true },
          links: null,
          counts: null,
        },
      } as unknown as InboxItem["details"],
    });

    expect(getAutopilotRunOutcome(malformed)).toBeNull();
  });
});
