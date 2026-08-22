import { describe, expect, it } from "vitest";
import { deriveScmSettings } from "./settings";

describe("deriveScmSettings", () => {
  it("uses provider-independent defaults", () => {
    expect(deriveScmSettings(null)).toEqual({
      changeSidebar: true,
      autoLink: true,
      completeIssueOnMerge: false,
      coAuthor: true,
    });
  });

  it("reads the canonical SCM workspace settings", () => {
    expect(deriveScmSettings({
      settings: {
        scm_change_sidebar_enabled: false,
        scm_auto_link_enabled: false,
        scm_complete_issue_on_merge_enabled: true,
        co_authored_by_enabled: false,
      },
    })).toEqual({
      changeSidebar: false,
      autoLink: false,
      completeIssueOnMerge: true,
      coAuthor: false,
    });
  });

  it("does not honor deleted GitHub-only settings", () => {
    expect(deriveScmSettings({
      settings: {
        github_enabled: false,
        github_pr_sidebar_enabled: false,
        github_auto_link_enabled: false,
      },
    })).toEqual({
      changeSidebar: true,
      autoLink: true,
      completeIssueOnMerge: false,
      coAuthor: true,
    });
  });
});
