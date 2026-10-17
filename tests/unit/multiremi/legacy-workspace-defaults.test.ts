import { describe, expect, it } from "bun:test";
import { customWorkspacePrompt, mergedWorkspacePrompt } from "@multiremi/contracts/remi-rules.js";
import {
  LEGACY_WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULT_V1,
  WORKSPACE_DEFAULT_V2,
  WORKSPACE_DEFAULT_V2_REWRITTEN,
  WORKSPACE_DEFAULT_V3,
} from "@multiremi/contracts/legacy-workspace-prompts.js";
import { rewriteText } from "../../../scripts/migrations/rewrite-retired-cli-commands.js";

describe("historical workspace prompt defaults (ADR 0023)", () => {
  it("are the texts the database can hold", () => {
    // The rewrite migration produced the third from the second; nothing else may change them.
    expect(rewriteText(WORKSPACE_DEFAULT_V2)).toBe(WORKSPACE_DEFAULT_V2_REWRITTEN);
    for (const later of [WORKSPACE_DEFAULT_V2, WORKSPACE_DEFAULT_V2_REWRITTEN, WORKSPACE_DEFAULT_V3]) {
      expect(later.startsWith(WORKSPACE_DEFAULT_V1)).toBe(true);
    }
    expect(LEGACY_WORKSPACE_DEFAULTS.map(text => text.length)).toEqual(
      [...LEGACY_WORKSPACE_DEFAULTS].map(text => text.length).sort((left, right) => right - left));
  });

  it("strips every one of them, the longest that matches", () => {
    for (const [name, value] of Object.entries({ WORKSPACE_DEFAULT_V1, WORKSPACE_DEFAULT_V2, WORKSPACE_DEFAULT_V2_REWRITTEN, WORKSPACE_DEFAULT_V3 })) {
      expect([name, customWorkspacePrompt(value)]).toEqual([name, ""]);
      expect([name, customWorkspacePrompt(`${value}\n\nOwn rule.`)]).toEqual([name, "Own rule."]);
      expect([name, customWorkspacePrompt(`${value.replace(/\n/g, "\r\n")}\r\n\r\nOwn rule.\r\n`)]).toEqual([name, "Own rule."]);
      expect([name, mergedWorkspacePrompt(`${value}\n\nOwn rule.`, "Delta rule.")]).toEqual([name, "Own rule.\n\nDelta rule."]);
    }
    // An edited default is the workspace's own text and stays whole.
    const edited = WORKSPACE_DEFAULT_V2.replace("Push the working branch", "Push the branch");
    expect(customWorkspacePrompt(edited)).toBe(edited);
  });
});
