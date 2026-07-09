import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateBridgePackage, bridgeVersion, bridgeSatisfied, BRIDGE_PIN } from "@acp/provision.js";

let dir: string | null = null;
const savedHome = process.env.REMI_HOME;
const savedPath = process.env.PATH;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  if (savedHome === undefined) delete process.env.REMI_HOME;
  else process.env.REMI_HOME = savedHome;
  process.env.PATH = savedPath;
});

function freshHome(): string {
  dir = mkdtempSync(join(tmpdir(), "remi-provision-"));
  process.env.REMI_HOME = dir;
  return dir;
}

function writeBridgePackage(home: string, pkg: string, version: string): string {
  const pkgDir = join(home, "acp", "node_modules", ...pkg.split("/"));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  return pkgDir;
}

test("locateBridgePackage + bridgeVersion read the provisioned bridge's package.json", () => {
  const home = freshHome();
  const pkgDir = writeBridgePackage(home, "@agentclientprotocol/claude-agent-acp", "0.53.0");
  expect(locateBridgePackage("claude")).toBe(pkgDir);
  expect(bridgeVersion("claude")).toBe("0.53.0");
});

test("the deprecated @zed-industries claude bridge is no longer recognized", () => {
  const home = freshHome();
  writeBridgePackage(home, "@zed-industries/claude-agent-acp", "0.23.1");
  expect(locateBridgePackage("claude")).toBeNull();
  expect(bridgeSatisfied("claude")).toBe(false);
});

test("bridgeSatisfied requires exactly the pinned version", () => {
  const home = freshHome();
  writeBridgePackage(home, "@agentclientprotocol/codex-acp", "1.0.2");
  expect(bridgeSatisfied("codex")).toBe(false);

  rmSync(join(home, "acp"), { recursive: true, force: true });
  writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  expect(bridgeSatisfied("codex")).toBe(true);
});

test("a bridge binary on PATH alone does not satisfy the pin (legacy Rust codex-acp)", () => {
  const home = freshHome();
  // Make sure SOME codex-acp binary is resolvable on PATH even on machines
  // that don't carry the real legacy one; the pin must ignore it regardless.
  const binDir = join(home, "stray-bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "codex-acp");
  writeFileSync(bin, "#!/bin/sh\necho codex-acp 0.0.44\n");
  chmodSync(bin, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

  expect(bridgeSatisfied("codex")).toBe(false);
});
