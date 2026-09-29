import { describe, expect, it } from "bun:test";
import { ClaudeAdapter } from "@acp/adapters/claude-code/index.js";
import { resolveClaudeContextSelection, hasOneMillionContext } from "@acp/adapters/claude-code/model-context.js";

describe("Claude context model selection", () => {
  it.each(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "gateway/custom-model", "sonnet"])(
    "uses only the declaration for %s", model => {
      expect(resolveClaudeContextSelection(model).customModelOption).toBeNull();
      expect(resolveClaudeContextSelection(model, [model]).customModelOption).toBe(`${model}[1m]`);
      expect(resolveClaudeContextSelection(model, ["another-model"]).customModelOption).toBeNull();
    },
  );

  it.each([null, "", "  "])("ignores an empty model: %s", model => {
    expect(resolveClaudeContextSelection(model, [""]).customModelOption).toBeNull();
  });

  it("trims the requested ID", () => {
    expect(resolveClaudeContextSelection("  claude-opus-5  ", ["claude-opus-5"]).customModelOption).toBe("claude-opus-5[1m]");
  });

  it.each([
    null, "", "  ", "default", "auto", "opus", "sonnet", "fable", "haiku",
    "deepseek-flash", "sonnet-custom", "gateway/claude-fable-5-1",
    "claude-opus-5[200k]", "claude-opus-5[other]", "claude-opus-5[1m]",
    "claude-", "claude-opus-5.5", "claude_opus_5", "claude-opus-5 custom",
    "gpt-5.5", "gpt-5.5[xhigh]",
  ])("leaves undeclared models alone: %s", (model) => {
    expect(resolveClaudeContextSelection(model).customModelOption).toBeNull();
  });

  it.each(["claude-fable-5-1[1m]", "opus[1m]", "custom-model[1M]"])("preserves explicit %s", (model) => {
    expect(resolveClaudeContextSelection(model, [model]).customModelOption).toBeNull();
    expect(hasOneMillionContext(model)).toBe(true);
    expect(new ClaudeAdapter().buildSessionMeta({ model })).toEqual({ claudeCode: { options: { model } } });
  });

  it("places custom model env in CLI options independently of SDK settings", () => {
    const claudeEnv = { ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-5[1m]" };
    const claudeSettings = { model: "claude-opus-5", env: { ANTHROPIC_BASE_URL: "https://example.test" } };
    expect(new ClaudeAdapter().buildSessionMeta({ model: "claude-opus-5", claudeEnv, claudeSettings })).toEqual({
      claudeCode: { options: { model: "claude-opus-5", env: claudeEnv, settings: claudeSettings } },
    });
    expect(hasOneMillionContext("claude-fable-5-1[200k]")).toBe(false);
  });
});
