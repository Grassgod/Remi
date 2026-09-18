import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locateBridgePackage,
  bridgeVersion,
  bridgeSatisfied,
  patchCodexUsageBridge,
  BRIDGE_PIN,
  CODEX_USAGE_PATCH,
  RUNTIME_PIN,
  ensureAcpBridges,
} from "@acp/provision.js";
import { runtimeBundlePrefix, runtimeBundleManifest, runtimePackageSatisfied } from "@acp/runtime-bundle.js";

let dir: string | null = null;
const savedHome = process.env.REMI_HOME;
const savedPath = process.env.PATH;
const savedBridgeDir = process.env.REMI_CLAUDE_AGENT_ACP_DIR;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  if (savedHome === undefined) delete process.env.REMI_HOME;
  else process.env.REMI_HOME = savedHome;
  process.env.PATH = savedPath;
  if (savedBridgeDir === undefined) delete process.env.REMI_CLAUDE_AGENT_ACP_DIR;
  else process.env.REMI_CLAUDE_AGENT_ACP_DIR = savedBridgeDir;
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

function writeSdk(home: string, provider: "claude" | "codex", version: string = RUNTIME_PIN[provider].version, modules = join(home, "acp", "node_modules")): string {
  const root = join(modules, RUNTIME_PIN[provider].package);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: RUNTIME_PIN[provider].package, version, main: "sdk.mjs" }));
  writeFileSync(join(root, "sdk.mjs"), "export {};\n");
  writeFileSync(join(root, "cli.js"), "// Claude executable fixture\n");
  writeFileSync(join(root, "bin", "codex.js"), "// Codex executable fixture\n");
  return root;
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
  // Even a fully patched previous pin must be upgraded on the next start.
  const previous = writeBridgePackage(home, "@agentclientprotocol/codex-acp", "1.1.14");
  writeCodexDist(previous);
  expect(patchCodexUsageBridge(() => {}, previous)).toBe(true);
  expect(bridgeSatisfied("codex")).toBe(false);

  rmSync(join(home, "acp"), { recursive: true, force: true });
  const pkgDir = writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  writeCodexDist(pkgDir);
  expect(bridgeSatisfied("codex")).toBe(false);
  expect(patchCodexUsageBridge(() => {}, pkgDir)).toBe(true);
  // A bridge at the pin is insufficient when its actual SDK is missing/old.
  expect(bridgeSatisfied("codex")).toBe(false);
  writeSdk(home, "codex");
  expect(bridgeSatisfied("codex")).toBe(true);
});

test("a current Claude ACP with the old bundled SDK still needs preparation", () => {
  const home = freshHome();
  const bridge = writeBridgePackage(home, "@agentclientprotocol/claude-agent-acp", BRIDGE_PIN.claude);
  writeSdk(home, "claude", "0.3.220");
  expect(bridgeSatisfied("claude")).toBe(false);
  writeSdk(home, "claude");
  expect(bridgeSatisfied("claude")).toBe(true);
  // A nested old SDK can shadow a correct top-level one.
  writeSdk(home, "claude", "0.3.220", join(bridge, "node_modules"));
  expect(runtimePackageSatisfied("claude", bridge)).toBe(false);
});

test("release bundle takes precedence over legacy/global bridges", () => {
  const home = freshHome();
  writeBridgePackage(home, "@agentclientprotocol/claude-agent-acp", "0.53.0");
  const prefix = runtimeBundlePrefix("claude");
  const bridge = join(prefix, "node_modules", "@agentclientprotocol", "claude-agent-acp");
  mkdirSync(bridge, { recursive: true });
  writeFileSync(join(bridge, "package.json"), JSON.stringify({ version: BRIDGE_PIN.claude }));
  expect(locateBridgePackage("claude")).toBe(bridge);
  expect(runtimeBundleManifest("claude").overrides).toEqual({ "@anthropic-ai/claude-agent-sdk": RUNTIME_PIN.claude.version });
  expect(runtimeBundleManifest("codex").overrides).toEqual({ "@openai/codex": RUNTIME_PIN.codex.version });
});

test("preflight preserves the old Codex launcher until normal daemon startup activates the bundle", () => {
  const home = freshHome();
  const bridge = writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  const dist = writeCodexDist(bridge);
  writeSdk(home, "codex");
  patchCodexUsageBridge(() => {}, bridge);
  const launcher = join(home, "bin", "codex-acp");
  mkdirSync(join(home, "bin"));
  writeFileSync(launcher, "old runtime launcher");
  ensureAcpBridges(["codex"], () => {}, { activate: false });
  expect(readFileSync(launcher, "utf8")).toBe("old runtime launcher");
  ensureAcpBridges(["codex"], () => {});
  expect(readlinkSync(launcher)).toBe(dist);
});

test("codex usage patch is idempotent and carries the complete last-request split", () => {
  const home = freshHome();
  const pkgDir = writeBridgePackage(home, "@agentclientprotocol/codex-acp", BRIDGE_PIN.codex);
  const dist = writeCodexDist(pkgDir);
  chmodSync(dist, 0o755);
  const originalMode = statSync(dist).mode;
  const logs: string[] = [];

  expect(patchCodexUsageBridge((message) => logs.push(message), pkgDir)).toBe(true);
  const once = readFileSync(dist, "utf8");
  expect(once).toContain(`const CODEX_USAGE_PATCH = "${CODEX_USAGE_PATCH}";`);
  expect(once).toContain("remiTokenUsage");
  expect(once).toContain("cachedInputTokens: this.sessionState.lastTokenUsage.cachedInputTokens");
  expect(patchCodexUsageBridge((message) => logs.push(message), pkgDir)).toBe(true);
  expect(readFileSync(dist, "utf8")).toBe(once);
  expect(once.match(/remiTokenUsage/g)).toHaveLength(1);
  expect(statSync(dist).mode).toBe(originalMode);
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
