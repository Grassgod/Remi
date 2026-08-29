import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locateBridgePackage,
  bridgeVersion,
  bridgeSatisfied,
  patchCodexUsageBridge,
  BRIDGE_PIN,
  CODEX_USAGE_PATCH,
} from "@acp/provision.js";

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

function writeCodexDist(pkgDir: string, source = `  createUsageUpdate() {
    return {
      sessionUpdate: "usage_update",
      used,
      size
    };
  }
`): string {
  const dist = join(pkgDir, "dist", "index.js");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(dist, source);
  return dist;
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
  const pkgDir = writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  writeCodexDist(pkgDir);
  expect(bridgeSatisfied("codex")).toBe(false);
  expect(patchCodexUsageBridge(() => {}, pkgDir)).toBe(true);
  expect(bridgeSatisfied("codex")).toBe(true);
});

test("codex usage patch is idempotent and carries the complete last-request split", () => {
  const home = freshHome();
  const pkgDir = writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  const dist = writeCodexDist(pkgDir);
  const logs: string[] = [];

  expect(patchCodexUsageBridge((message) => logs.push(message), pkgDir)).toBe(true);
  const once = readFileSync(dist, "utf8");
  expect(once).toContain(`const CODEX_USAGE_PATCH = "${CODEX_USAGE_PATCH}";`);
  expect(once).toContain("remiTokenUsage");
  expect(once).toContain("cachedInputTokens: this.sessionState.lastTokenUsage.cachedInputTokens");
  expect(patchCodexUsageBridge((message) => logs.push(message), pkgDir)).toBe(true);
  expect(readFileSync(dist, "utf8")).toBe(once);
  expect(once.match(/remiTokenUsage/g)).toHaveLength(1);
});

test("codex usage patch logs and degrades when its anchor is missing", () => {
  const home = freshHome();
  const pkgDir = writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  const dist = writeCodexDist(pkgDir, "// unknown future codex-acp layout\n");
  const logs: string[] = [];

  expect(patchCodexUsageBridge((message) => logs.push(message), pkgDir)).toBe(false);
  expect(logs.join("\n")).toContain("anchor missing");
  expect(readFileSync(dist, "utf8")).toBe("// unknown future codex-acp layout\n");
  expect(bridgeSatisfied("codex")).toBe(false);
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
