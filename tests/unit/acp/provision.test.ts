import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateBridgePackage, bridgeVersion } from "../../../src/acp/provision.js";

let dir: string | null = null;
const savedHome = process.env.REMI_HOME;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  if (savedHome === undefined) delete process.env.REMI_HOME;
  else process.env.REMI_HOME = savedHome;
});

test("locateBridgePackage + bridgeVersion read the provisioned bridge's package.json", () => {
  dir = mkdtempSync(join(tmpdir(), "remi-provision-"));
  process.env.REMI_HOME = dir;
  const pkgDir = join(dir, "acp", "node_modules", "@zed-industries", "claude-agent-acp");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@zed-industries/claude-agent-acp", version: "0.44.1" }),
  );
  expect(locateBridgePackage("claude")).toBe(pkgDir);
  expect(bridgeVersion("claude")).toBe("0.44.1");
});

test("locateBridgePackage prefers the maintained @agentclientprotocol claude bridge", () => {
  dir = mkdtempSync(join(tmpdir(), "remi-provision-"));
  process.env.REMI_HOME = dir;
  const zedDir = join(dir, "acp", "node_modules", "@zed-industries", "claude-agent-acp");
  const acpDir = join(dir, "acp", "node_modules", "@agentclientprotocol", "claude-agent-acp");
  mkdirSync(zedDir, { recursive: true });
  mkdirSync(acpDir, { recursive: true });
  writeFileSync(join(zedDir, "package.json"), JSON.stringify({ version: "0.23.1" }));
  writeFileSync(join(acpDir, "package.json"), JSON.stringify({ version: "0.53.0" }));
  expect(locateBridgePackage("claude")).toBe(acpDir);
  expect(bridgeVersion("claude")).toBe("0.53.0");
});
