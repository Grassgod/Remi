import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const wrapper = resolve(import.meta.dir, "../../../bin/remi-claude-agent-acp");
const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fakeCli(path: string, version: string): string {
  put(path, `#!${node}\nconsole.log(${JSON.stringify(version + " (Claude Code)")});\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixture(version = "2.1.259", hoisted = true) {
  const root = mkdtempSync(join(tmpdir(), "claude-runtime-wrapper-"));
  roots.push(root);
  const modules = join(root, "node_modules");
  const bridge = join(modules, "@agentclientprotocol", "claude-agent-acp");
  put(join(bridge, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.66.0" }));
  put(join(bridge, "dist", "acp-agent.js"), '// handleAskUserQuestion toolName === "AskUserQuestion"\n');
  put(join(bridge, "dist", "index.js"), 'console.log(JSON.stringify({executable: process.env.CLAUDE_CODE_EXECUTABLE}));\n');
  const sdkModules = hoisted ? modules : join(bridge, "node_modules");
  const sdk = join(sdkModules, "@anthropic-ai", "claude-agent-sdk");
  put(join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.220", main: "sdk.mjs" }));
  put(join(sdk, "sdk.mjs"), "export {};\n");
  const libcSuffix = process.platform === "linux" && !(process.report!.getReport() as any).header.glibcVersionRuntime ? "-musl" : "";
  const executable = fakeCli(join(sdkModules, "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}${libcSuffix}`, "claude"), version);
  const env: NodeJS.ProcessEnv = { ...process.env, REMI_HOME: root, REMI_CLAUDE_AGENT_ACP_DIR: bridge };
  delete env.REMI_CLAUDE_CODE_EXECUTABLE;
  delete env.CLAUDE_CODE_EXECUTABLE;
  delete env.REMI_CLAUDE_AGENT_ACP_PACKAGE;
  delete env.REMI_CLAUDE_AGENT_ACP_PATH;
  return { root, executable, env };
}

describe("Claude runtime wrapper", () => {
  it.each([true, false])("validates the real executable in a hoisted=%s SDK install", (hoisted) => {
    const f = fixture("2.1.259", hoisted);
    const result = spawnSync(node, [wrapper], { env: f.env, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).executable).toBe(f.executable);
    expect(result.stderr).toContain("Claude Code 2.1.259 (bundled-sdk)");
  }, 20000);

  it("honors an explicit newer CLI instead of the SDK's older binary", () => {
    const f = fixture("2.1.220");
    const executable = fakeCli(join(f.root, "newer-claude"), "2.1.259");
    const result = spawnSync(node, [wrapper], { env: { ...f.env, CLAUDE_CODE_EXECUTABLE: executable }, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).executable).toBe(executable);
    expect(result.stderr).toContain("explicit-cli");
  }, 20000);

  it("rejects an explicit outdated runtime even when a newer SDK is installed", () => {
    const f = fixture();
    const executable = fakeCli(join(f.root, "old-claude"), "2.1.220");
    const result = spawnSync(node, [wrapper, "--verify-patch"], { env: { ...f.env, CLAUDE_CODE_EXECUTABLE: executable }, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("minimum Claude Code version is 2.1.259");
  }, 20000);
});
