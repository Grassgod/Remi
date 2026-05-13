import { describe, expect, it } from "bun:test";
import {
  buildSwitchTarget,
  defaultSwitchMode,
  parseSwitchArgs,
  resolveSwitchProviderAlias,
} from "../src/switch-mode.js";

describe("switch mode helpers", () => {
  it("routes claude switches to ACP Claude by default", () => {
    expect(resolveSwitchProviderAlias("claude")).toBe("acp:claude");
    expect(resolveSwitchProviderAlias("acp:claude")).toBe("acp:claude");
    expect(resolveSwitchProviderAlias("cli")).toBe("claude_cli");
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

  it("defaults ACP Claude to auto and stores that as default", () => {
    expect(defaultSwitchMode("acp:claude")).toBe("auto");
    expect(buildSwitchTarget("claude")).toEqual({
      providerName: "acp:claude",
      mode: "auto",
      storedMode: null,
      modeLabel: "auto",
    });
  });

  it("normalizes bypass aliases", () => {
    expect(buildSwitchTarget("claude", "bypass")).toEqual({
      providerName: "acp:claude",
      mode: "bypassPermissions",
      storedMode: "bypassPermissions",
      modeLabel: "bypass",
    });
  });
});
