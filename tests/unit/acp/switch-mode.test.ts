import { describe, expect, it } from "bun:test";
import {
  buildSwitchTarget,
  defaultSwitchMode,
  parseSwitchArgs,
  resolveSwitchProviderAlias,
} from "../../../src/switch-mode.js";

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

  it("normalizes bypass aliases", () => {
    expect(buildSwitchTarget("claude", "bypass")).toEqual({
      providerName: "acp:claude",
      mode: "bypassPermissions",
      storedMode: null,
      modeLabel: "bypass",
    });
  });
});
