import { describe, expect, it } from "vitest";
import { formatRelayFragment } from "./relay-fragment-format";

describe("formatRelayFragment", () => {
  it("indents a single-line Claude fragment", () => {
    expect(formatRelayFragment("claude", '{"env":{"ANTHROPIC_BASE_URL":"https://ai.openremi.fun"}}')).toBe(
      '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://ai.openremi.fun"\n  }\n}',
    );
  });

  it("indents a single-line Antigravity fragment", () => {
    expect(formatRelayFragment(
      "antigravity",
      '{"base_url":"https://ai.openremi.fun/antigravity","default_model":"gemini-3.7-flash"}',
    )).toBe('{\n  "base_url": "https://ai.openremi.fun/antigravity",\n  "default_model": "gemini-3.7-flash"\n}');
  });

  it("expands inline Codex tables into standard TOML sections", () => {
    const compact = [
      'model_provider = "OpenAI"',
      'model_providers = { OpenAI = { base_url = "https://ai.openremi.fun/v1", wire_api = "responses", requires_openai_auth = true } }',
    ].join("\n");
    expect(formatRelayFragment("codex", compact)).toBe([
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://ai.openremi.fun/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
    ].join("\n"));
  });

  it("leaves empty and unparseable fragments exactly as stored", () => {
    expect(formatRelayFragment("claude", "")).toBe("");
    expect(formatRelayFragment("claude", '{"env":')).toBe('{"env":');
    expect(formatRelayFragment("codex", "model_provider = ")).toBe("model_provider = ");
    expect(formatRelayFragment("antigravity", "not json")).toBe("not json");
  });
});
