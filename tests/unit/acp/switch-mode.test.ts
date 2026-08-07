import { describe, expect, it } from "bun:test";
import {
  availableSwitchModes,
  buildSwitchTarget,
  defaultSwitchMode,
  isKnownSwitchMode,
  parseSwitchArgs,
  resolveSwitchProviderAlias,
} from "@acp/switch-mode.js";

describe("switch mode helpers", () => {
  it("routes claude switches to ACP Claude by default", () => {
    expect(resolveSwitchProviderAlias("claude")).toBe("acp:claude");
    expect(resolveSwitchProviderAlias("acp:claude")).toBe("acp:claude");
    expect(resolveSwitchProviderAlias("codex")).toBe("acp:codex");
  });

  it("uses the last colon so ACP provider ids can include a colon", () => {
    expect(parseSwitchArgs("acp:claude:auto")).toEqual({
      providerAlias: "acp:claude",
      modeArg: "auto",
    });
    expect(parseSwitchArgs("claude:plan")).toEqual({
      providerAlias: "claude",
      modeArg: "plan",
    });
  });

  it("defaults ACP Claude to bypassPermissions", () => {
    expect(defaultSwitchMode("acp:claude")).toBe("bypassPermissions");
    expect(buildSwitchTarget("claude")).toEqual({
      providerName: "acp:claude",
      mode: "bypassPermissions",
      storedMode: null,
      modeLabel: "bypass",
    });
  });

  // claude-agent-acp computes availableModes per session and per model
  // (dist/acp-agent.js:4909-4945): `auto` only when the model supports it,
  // `bypassPermissions` only when !IS_ROOT || IS_SANDBOX. codex-acp advertises
  // read-only/agent/agent-full-access. A hardcoded list offered modes the agent
  // would reject and hid ones it supports.
  it("uses the agent's advertised modes when a session exists", () => {
    const claudeOnRoot = {
      currentModeId: "default",
      availableModes: [
        { id: "auto", name: "Auto" },
        { id: "default", name: "Manual" },
        { id: "acceptEdits", name: "Accept Edits" },
        { id: "plan", name: "Plan Mode" },
        { id: "dontAsk", name: "Don't Ask" },
      ],
    };
    expect(availableSwitchModes("acp:claude", claudeOnRoot)).toEqual([
      "auto", "default", "acceptEdits", "plan", "dontAsk",
    ]);
    expect(isKnownSwitchMode("acp:claude", "auto", claudeOnRoot)).toBe(true);
    expect(isKnownSwitchMode("acp:claude", "bypassPermissions", claudeOnRoot)).toBe(false);

    const codex = {
      currentModeId: "agent",
      availableModes: [{ id: "read-only", name: "Read-only" }, { id: "agent", name: "Agent" }],
    };
    expect(availableSwitchModes("acp:codex", codex)).toEqual(["read-only", "agent"]);
    expect(isKnownSwitchMode("acp:codex", "read-only", codex)).toBe(true);
    expect(isKnownSwitchMode("acp:codex", "plan", codex)).toBe(false);
  });

  it("falls back to the static list before a session exists", () => {
    expect(availableSwitchModes("acp:claude")).toEqual([
      "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions",
    ]);
    expect(isKnownSwitchMode("acp:claude", "bypassPermissions")).toBe(true);
    expect(isKnownSwitchMode("acp:claude", "auto", { currentModeId: "x", availableModes: [] })).toBe(false);
  });

  it("normalizes bypass aliases", () => {
    expect(buildSwitchTarget("claude", "bypass")).toEqual({
      providerName: "acp:claude",
      mode: "bypassPermissions",
      storedMode: null,
      modeLabel: "bypass",
    });
  });
});
