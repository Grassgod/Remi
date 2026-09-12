import { describe, expect, it } from "vitest";
import { allowsLocalTokenLogin, allowsPasswordLogin } from "./local-profile";

describe("local profile token login", () => {
  it("allows password login at the configured stable LAN host without exposing local key login", () => {
    const site = "http://192.168.40.12:13000";
    expect(allowsPasswordLogin("stable", "192.168.40.12", site)).toBe(true);
    expect(allowsLocalTokenLogin("stable", "192.168.40.12")).toBe(false);
    expect(allowsPasswordLogin("dev", "192.168.40.12", site)).toBe(false);
    expect(allowsPasswordLogin("stable", "192.168.40.13", site)).toBe(false);
    for (const invalid of [undefined, "", "invalid", "file://192.168.40.12"]) {
      expect(allowsPasswordLogin("stable", "192.168.40.12", invalid)).toBe(false);
    }
  });
  it.each(["dev", "stable"])("allows %s only on exact local hostnames", (profile) => {
    expect(allowsLocalTokenLogin(profile, "localhost")).toBe(true);
    expect(allowsLocalTokenLogin(profile, "127.0.0.1")).toBe(true);
    expect(allowsPasswordLogin(profile, "localhost")).toBe(true);
    expect(allowsPasswordLogin(profile, "127.0.0.1")).toBe(true);
    for (const hostname of ["remi.example.com", "localhost.example.com", "dev.localhost", "192.168.1.2", "::1", ""]) {
      expect(allowsLocalTokenLogin(profile, hostname)).toBe(false);
      expect(allowsPasswordLogin(profile, hostname)).toBe(false);
    }
  });

  it.each([undefined, "", "production", "test", "DEV"])("rejects an unspecified or unsupported profile: %s", (profile) => {
    expect(allowsLocalTokenLogin(profile, "localhost")).toBe(false);
    expect(allowsPasswordLogin(profile, "localhost")).toBe(false);
  });
});
