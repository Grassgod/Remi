import { test, expect } from "bun:test";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { AcpProvider } from "../src/agent/acp/index.js";
import type { AgentEvent, AgentResult } from "../src/agent/types.js";

const MOCK = join(import.meta.dir, "fixtures", "mock-acp-agent.ts");
chmodSync(MOCK, 0o755); // Bun.spawn([MOCK]) runs it via the shebang.

test("AcpProvider drives a full ACP turn against a mock agent", async () => {
  const provider = new AcpProvider();
  const events: AgentEvent[] = [];

  const gen = provider.execute({
    agentType: "codex",
    prompt: "hello world",
    executable: MOCK,
  });

  let result: AgentResult | undefined;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }

  expect(result).toBeDefined();
  expect(result!.stopReason).toBe("end_turn");
  expect(result!.text).toContain("echo: hello world");
  expect(result!.sessionId).toBe("mock-session-1");
  expect(events.some((e) => e.kind === "thought")).toBe(true);
  expect(events.some((e) => e.kind === "text")).toBe(true);
});

test("createAdapter resolves codex and claude to the right ACP executables", async () => {
  const { createAdapter } = await import("../src/agent/acp/index.js");
  expect(createAdapter("codex").defaultExecutable()).toBe("codex-acp");
  expect(createAdapter("claude").agentType).toBe("claude");
});

test("native-ACP agents (hermes/kimi/kiro) collapse into the unified provider", async () => {
  const { createAdapter, supportedAgentTypes } = await import("../src/agent/acp/index.js");
  expect(createAdapter("hermes").defaultExecutable()).toBe("hermes");
  expect(createAdapter("kimi").defaultExecutable()).toBe("kimi");
  expect(createAdapter("kiro").defaultExecutable()).toBe("kiro-cli");
  // The full 12-agent unification is asserted in acp-adapters.test.ts; here we
  // just confirm the native-ACP trio is among the registered agents.
  for (const t of ["claude", "codex", "hermes", "kimi", "kiro"]) {
    expect(supportedAgentTypes()).toContain(t);
  }
});

test("the same AcpProvider drives a hermes turn (mock agent)", async () => {
  const provider = new AcpProvider();
  const gen = provider.execute({ agentType: "hermes", prompt: "ping", executable: MOCK });
  let result: AgentResult | undefined;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
  }
  expect(result!.stopReason).toBe("end_turn");
  expect(result!.text).toContain("echo: ping");
});
