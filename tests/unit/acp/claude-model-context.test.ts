import { describe, expect, it } from "bun:test";
import { ClaudeAdapter } from "@acp/adapters/claude-code/index.js";
import { resolveClaudeContextModel } from "@acp/adapters/claude-code/model-context.js";

describe("Claude context model selection", () => {
  it.each([
    "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
    "claude-fable-5", "claude-fable-5-1", "claude-sonnet-4-6", "claude-sonnet-5",
  ])("selects the 1M lane for %s", (model) => {
    expect(resolveClaudeContextModel(model)).toBe(`${model}[1m]`);
  });

  it.each([
    null, "", "default", "auto", "opus", "sonnet", "fable", "haiku",
    "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5",
    "gateway/claude-fable-5-1", "claude-fable-5-10", "claude-opus-6",
    "claude-opus-5[200k]", "gpt-5.5", "gpt-5.5[xhigh]",
  ])("does not guess the window of %s", (model) => {
    expect(resolveClaudeContextModel(model)).toBe(model);
  });

  it.each(["claude-fable-5-1[1m]", "opus[1m]", "custom-model[1M]"])("preserves explicit %s", (model) => {
    expect(resolveClaudeContextModel(model)).toBe(model);
    expect(new ClaudeAdapter().buildSessionMeta({ model })).toEqual({ claudeCode: { options: { model } } });
  });

  it("honors the native 1M opt-out without stripping an explicit user selection", () => {
    expect(resolveClaudeContextModel("claude-fable-5-1", "1")).toBe("claude-fable-5-1");
    expect(resolveClaudeContextModel("claude-fable-5-1", "0")).toBe("claude-fable-5-1[1m]");
    expect(resolveClaudeContextModel("claude-fable-5-1[1m]", "1")).toBe("claude-fable-5-1[1m]");
  });
});
