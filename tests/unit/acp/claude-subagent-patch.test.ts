/**
 * The Claude native-subagent facts patch (PR 5, option A): claude-agent-acp
 * 0.90's `subagent_spawned` gains `_meta.remi = { backgrounded, subagentType }`
 * from the SDK's `task_started`.
 *
 * Three levels: the patched anchors executed against a reduced boundary
 * (tests/fixtures/acp/claude-acp-subagent-boundary.ts); the install path
 * (a missing anchor fails it, an older install is stale); and the pinned real
 * dist when one is provided. The real-dist test runs when
 * `MULTIREMI_TEST_CLAUDE_ACP_DIST` names the `dist` directory of an installed
 * `@agentclientprotocol/claude-agent-acp`, and skips otherwise (the repo has no
 * installed bridge; `release:prepare` patches the real candidate in any case).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLAUDE_SUBAGENT_PATCH_MARKER,
  claudeSubagentPatch,
  claudeUsagePatch,
  stripClaudeSubagentPatch,
} from "@acp/usage-bridge-patches.js";
import { patchClaudeUsageBridge } from "@acp/provision.js";
import { CLAUDE_SUBAGENT_BOUNDARY } from "../../fixtures/acp/claude-acp-subagent-boundary.js";
import runtimeVersions from "../../../packages/acp/src/runtime-versions.json";

const USAGE_BOUNDARY = "                if (session.emitRawSDKMessages && true) {}\n";

/** Run the patched boundary: SDK task messages, then announcements through the runtime's publish callback. */
async function run(source: string, steps: Array<Record<string, unknown>>) {
  const Session = new Function(`return class { ${source} }`)();
  const sent: any[] = [];
  const instance = new Session();
  instance.clientCapabilities = {};
  instance.logger = { log() {} };
  instance.client = { sessionUpdate: async (notification: unknown) => { sent.push(notification); } };
  class Runtime {
    constructor(_form: unknown, _root: string, _session: unknown, readonly publish: (notification: unknown) => Promise<void>) {}
    async taskStarted() {}
  }
  const session: Record<string, unknown> = {};
  await instance.runSession({ sessionId: "root" }, session, Runtime, () => "air", (notification: unknown) => notification, steps,
    (runtime: Runtime, message: { update: Record<string, unknown> }) => runtime.publish({ sessionId: "root", update: message.update }));
  return sent.map((notification) => notification.update);
}

const started = (taskId: string, isBackgrounded?: boolean, subagentType?: string) =>
  ({ subtype: "task_started", task_id: taskId, tool_use_id: `toolu_${taskId}`, is_backgrounded: isBackgrounded, subagent_type: subagentType });
const announce = (subagentSessionId: string, extra: Record<string, unknown> = {}) =>
  ({ subtype: "announce", update: { sessionUpdate: "subagent_spawned", subagentSessionId, name: "Count files", task: "x", capabilities: {}, ...extra } });

describe("claudeSubagentPatch (reduced boundary)", () => {
  it("adds the task's background and type to its announcement; a resume runs in the background", async () => {
    const patched = claudeSubagentPatch(CLAUDE_SUBAGENT_BOUNDARY)!;
    expect(patched).toContain(CLAUDE_SUBAGENT_PATCH_MARKER);
    const updates = await run(patched, [
      started("bg", true, "general-purpose"), announce("bg"),
      started("fg", false, "Explore"), announce("fg", { _meta: { existing: 1 } }),
      announce("fg:generation:2"),
      announce("unknown"),
      { subtype: "announce", update: { sessionUpdate: "subagent_state_update", subagentSessionId: "bg", state: "completed" } },
    ]);
    expect(updates.map((update) => update._meta?.remi ?? null)).toEqual([
      { backgrounded: true, subagentType: "general-purpose" },
      { backgrounded: false, subagentType: "Explore" },
      { backgrounded: true, subagentType: "Explore" },
      { backgrounded: null, subagentType: null },
      null,
    ]);
    // Existing _meta is kept; other updates pass through untouched.
    expect(updates[1]._meta.existing).toBe(1);
    expect(updates[4]).toEqual({ sessionUpdate: "subagent_state_update", subagentSessionId: "bg", state: "completed" });
  });

  it("is idempotent, restorable, and refuses a missing or ambiguous anchor", () => {
    const patched = claudeSubagentPatch(CLAUDE_SUBAGENT_BOUNDARY)!;
    expect(claudeSubagentPatch(patched)).toBe(patched);
    expect(stripClaudeSubagentPatch(patched)).toBe(CLAUDE_SUBAGENT_BOUNDARY);
    // A bundle patched by an older version (no current marker) is re-patched from its upstream text.
    const older = patched.replace(CLAUDE_SUBAGENT_PATCH_MARKER, 'const REMI_SUBAGENT_PATCH = "claude-subagents-v0";');
    expect(claudeSubagentPatch(older)).toBe(patched);
    expect(claudeSubagentPatch(CLAUDE_SUBAGENT_BOUNDARY.replace("await subagents.taskStarted({", "await subagents.started({"))).toBeNull();
    expect(claudeSubagentPatch(CLAUDE_SUBAGENT_BOUNDARY.replace("new NativeSubagentRuntime(", "new SubagentRuntime("))).toBeNull();
    expect(claudeSubagentPatch(CLAUDE_SUBAGENT_BOUNDARY + CLAUDE_SUBAGENT_BOUNDARY)).toBeNull();
  });
});

describe("Claude bridge install with the subagent patch", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function bridge(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "claude-subagent-patch-"));
    dirs.push(dir);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "acp-agent.js"), source);
    return dir;
  }

  it("applies both patches, and fails when the subagent anchors are missing", () => {
    const logs: string[] = [];
    const good = bridge(USAGE_BOUNDARY + CLAUDE_SUBAGENT_BOUNDARY);
    expect(patchClaudeUsageBridge((line) => logs.push(line), good)).toBe(true);
    const source = readFileSync(join(good, "dist", "acp-agent.js"), "utf8");
    expect(source).toContain(CLAUDE_SUBAGENT_PATCH_MARKER);
    expect(source).toContain("const CLAUDE_USAGE_PATCH = ");
    // Idempotent on a second install pass.
    expect(patchClaudeUsageBridge(() => {}, good)).toBe(true);
    expect(readFileSync(join(good, "dist", "acp-agent.js"), "utf8")).toBe(source);

    const missing = bridge(USAGE_BOUNDARY);
    expect(patchClaudeUsageBridge((line) => logs.push(line), missing)).toBe(false);
    expect(logs.at(-1)).toContain("Claude subagent patch anchor missing");
    // Nothing half-applied: the file is left as it was.
    expect(readFileSync(join(missing, "dist", "acp-agent.js"), "utf8")).toBe(USAGE_BOUNDARY);
  });
});

const REAL_DIST = process.env.MULTIREMI_TEST_CLAUDE_ACP_DIST?.trim() ?? "";
const realVersion = (() => {
  try {
    return REAL_DIST ? (JSON.parse(readFileSync(join(dirname(REAL_DIST), "package.json"), "utf8")) as { version?: string }).version ?? null : null;
  } catch {
    return null;
  }
})();

describe.skipIf(!REAL_DIST || !existsSync(join(REAL_DIST, "acp-agent.js")))("claudeSubagentPatch on the pinned real dist", () => {
  it(`patches claude-agent-acp ${runtimeVersions.claude.acp} at exactly its anchors, with the usage patch`, () => {
    expect(realVersion).toBe(runtimeVersions.claude.acp);
    const upstream = readFileSync(join(REAL_DIST, "acp-agent.js"), "utf8");
    const usage = claudeUsagePatch(upstream);
    expect(usage).not.toBeNull();
    const patched = claudeSubagentPatch(usage!)!;
    expect(patched).not.toBeNull();
    expect(patched.split(CLAUDE_SUBAGENT_PATCH_MARKER)).toHaveLength(2);
    expect(claudeSubagentPatch(patched)).toBe(patched);
    expect(stripClaudeSubagentPatch(patched)).toBe(usage!);
    // Still a valid module (the bridge loads it as ESM).
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(patched)).not.toThrow();
    // The facts come from the same `task_started` the bridge already reads them in.
    expect(upstream).toContain("backgrounded: message.is_backgrounded,");
  });
});
