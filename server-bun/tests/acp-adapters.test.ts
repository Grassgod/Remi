/**
 * Proves the "12 Go backends → 1 ACP provider" unification:
 *   - every agent type the Go backend shipped resolves through ONE registry
 *     onto ONE unified AcpProvider code path;
 *   - the ACP launch (executable + args) is correct per agent;
 *   - and the single provider actually drives a turn for ANY agent type.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { createAdapter, supportedAgentTypes } from "../src/agent/acp/adapters/index.js";
import { AcpProvider } from "../src/agent/acp/index.js";
import type { AgentResult } from "../src/agent/types.js";

// The 12 agent types the Go backend implemented as 12 separate packages.
const TWELVE = [
  "claude", "codex", "gemini", "hermes", "kimi", "kiro",
  "opencode", "cursor", "copilot", "openclaw", "pi", "antigravity",
];

test("all 12 Go-backend agent types are registered on the unified provider", () => {
  const supported = supportedAgentTypes();
  expect(supported.length).toBe(12);
  for (const t of TWELVE) expect(supported).toContain(t);
});

test("every agent type resolves to one adapter with a valid ACP launch", () => {
  for (const t of TWELVE) {
    const a = createAdapter(t);
    expect(a.agentType).toBe(t);
    expect(a.defaultExecutable().length).toBeGreaterThan(0);
    // defaultArgs is optional but must be an array when present.
    const args = a.defaultArgs?.();
    if (args !== undefined) expect(Array.isArray(args)).toBe(true);
  }
});

test("ACP entrypoints are correct per agent (bridges, native flags, native CLIs)", () => {
  expect(createAdapter("claude").defaultExecutable()).toBe("claude-agent-acp");
  expect(createAdapter("codex").defaultExecutable()).toBe("codex-acp");
  // gemini speaks ACP only behind a flag — the args plumbing must carry it.
  expect(createAdapter("gemini").defaultExecutable()).toBe("gemini");
  expect(createAdapter("gemini").defaultArgs?.()).toEqual(["--experimental-acp"]);
  expect(createAdapter("antigravity").defaultExecutable()).toBe("agy");
});

// Regression guard: an ACP CLI launched WITHOUT its acp subcommand starts the
// interactive REPL and AcpClient.initialize() hangs. These args are ported
// verbatim from the Go backend (pkg/agent/{hermes,kimi,kiro}.go) and must not
// be dropped when collapsing the per-agent logic into the generic adapter.
test("native-ACP CLIs carry their exact Go acp launch args", () => {
  expect(createAdapter("hermes").defaultExecutable()).toBe("hermes");
  expect(createAdapter("hermes").defaultArgs?.()).toEqual(["acp"]);
  expect(createAdapter("kimi").defaultExecutable()).toBe("kimi");
  expect(createAdapter("kimi").defaultArgs?.()).toEqual(["acp"]);
  expect(createAdapter("kiro").defaultExecutable()).toBe("kiro-cli");
  expect(createAdapter("kiro").defaultArgs?.()).toEqual(["acp", "--trust-all-tools"]);
  expect(createAdapter("opencode").defaultArgs?.()).toEqual(["acp"]);
  // claude/codex use dedicated bridge binaries that speak ACP when run bare.
  expect(createAdapter("claude").defaultExecutable()).toBe("claude-agent-acp");
  expect(createAdapter("codex").defaultExecutable()).toBe("codex-acp");
});

test("unknown agent type fails loudly", () => {
  expect(() => createAdapter("definitely-not-an-agent")).toThrow(/Unknown agent type/);
});

// ── End-to-end: ONE provider drives ANY agent type ──────────────────────────
const MOCK = join(import.meta.dir, "fixtures", "mock-acp-agent.ts");
chmodSync(MOCK, 0o755);

async function drain(agentType: string): Promise<AgentResult> {
  const provider = new AcpProvider();
  const gen = provider.execute({
    agentType,
    prompt: "ping",
    executable: MOCK, // override the real binary with the mock ACP agent
  });
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

test("the single unified provider completes a turn for any of the 12 agent types", async () => {
  // Sample across every ACP tier: bridge, native-flag, native, external, unverified.
  for (const t of ["claude", "codex", "gemini", "hermes", "opencode", "copilot", "antigravity"]) {
    const result = await drain(t);
    expect(result.stopReason).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
  }
});
