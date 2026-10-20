/**
 * ADR 0025: the ACP provider keeps each session's latest
 * `available_commands_update`, whether it arrives right after `session/new`
 * (while no prompt listens, as both pinned bridges send it) or inside a prompt
 * (claude-agent-acp re-sends it once Claude Code names its terminal-only
 * commands). A child session's list is not the root's. No `_meta` and no path
 * is kept. Claude's duplicate reply to a local-only command is dropped.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProvider } from "@acp/provider.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { FakeSubagentConfig, FakeSubagentStep } from "../../fixtures/acp/fake-subagent-agent.js";

const AGENT = join(import.meta.dir, "../../fixtures/acp/fake-subagent-agent.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeAgent(agentType: "claude" | "codex", config: FakeSubagentConfig): AcpProvider {
  const dir = mkdtempSync(join(tmpdir(), "acp-commands-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const provider = new AcpProvider({
    agentType, executable: process.execPath, args: [AGENT], cwd: dir, getMcpServers: () => [],
    env: { FAKE_SUBAGENT_CONFIG_FILE: configPath, FAKE_SUBAGENT_LOG: join(dir, "frames.jsonl") },
    nativeSubagentSessions: true,
  });
  cleanups.push(async () => { await provider.close(); rmSync(dir, { recursive: true, force: true }); });
  return provider;
}

async function collect(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const commands = (...entries: Array<Record<string, unknown>>): FakeSubagentStep =>
  ({ update: { sessionUpdate: "available_commands_update", availableCommands: entries } });
const message = (messageId: string, text: string): FakeSubagentStep =>
  ({ update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } });
const rootTexts = (events: ProviderEvent[]) => events.flatMap((event) => event.sessionUpdate === "agent_message_chunk"
  && !(event as { _meta?: { remiSessionId?: string } })._meta?.remiSessionId
  ? [(event.content as unknown as { text: string }).text] : []);

const SETUP = commands(
  { name: "compact", description: "Free up context", input: { hint: "<instructions>" } },
  { name: "deploy-prod", description: "Deploy (project)", input: null,
    _meta: { jetbrains: { air: { version: 1, kind: "skill", skillPath: "/private/home/someone/work/.claude/skills/deploy-prod/SKILL.md" } } } },
  { name: "color", description: "Set the prompt bar color", input: { hint: "[red|blue]" } },
);

describe("AcpProvider.availableCommands", () => {
  it("keeps the list sent right after session/new, before any prompt listens", async () => {
    const provider = fakeAgent("claude", { afterSession: [SETUP], prompts: [[message("m1", "hi"), { resolve: "end_turn" }]] });
    expect(provider.availableCommands("chat")).toBeNull();
    await collect(provider.sendStream("hello", { chatId: "chat" }));
    const observed = provider.availableCommands("chat");
    expect(observed).toEqual([
      { name: "compact", description: "Free up context", hint: "<instructions>", kind: "command", skillDir: null },
      { name: "deploy-prod", description: "Deploy (project)", hint: null, kind: "skill", skillDir: "deploy-prod" },
      { name: "color", description: "Set the prompt bar color", hint: "[red|blue]", kind: "command", skillDir: null },
    ]);
    expect(JSON.stringify(observed)).not.toContain("/private/home");
    expect(provider.availableCommands("other")).toBeNull();
  });

  it("replaces it with the list re-sent inside a prompt, and keeps it across prompts", async () => {
    const filtered = commands({ name: "compact", description: "Free up context", input: { hint: "<instructions>" } });
    const provider = fakeAgent("claude", {
      afterSession: [SETUP],
      prompts: [[filtered, message("m1", "first"), { resolve: "end_turn" }], [message("m2", "second"), { resolve: "end_turn" }]],
    });
    await collect(provider.sendStream("hello", { chatId: "chat" }));
    expect(provider.availableCommands("chat")?.map((command) => command.name)).toEqual(["compact"]);
    await collect(provider.sendStream("again", { chatId: "chat" }));
    expect(provider.availableCommands("chat")?.map((command) => command.name)).toEqual(["compact"]);
  });

  it("takes an empty list as a real one, and never a child session's list", async () => {
    const child = "a0000000000000001";
    const provider = fakeAgent("codex", {
      afterSession: [commands()],
      prompts: [[
        { update: { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: "Helper", task: "Help", prompt: "Help", capabilities: {} } },
        { session: child, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "child-only", description: "" }] } },
        { update: { sessionUpdate: "subagent_state_update", subagentSessionId: child, state: "completed" } },
        message("m1", "done"),
        { resolve: "end_turn" },
      ]],
    });
    await collect(provider.sendStream("hello", { chatId: "chat" }));
    expect(provider.availableCommands("chat")).toEqual([]);
  });
});

describe("Claude's duplicate reply to a local-only command", () => {
  const duplicated: FakeSubagentStep[] = [
    message("out-1", "## Context Usage\n\n| Category | Tokens |"),
    { billing: {} },
    message("result-1", "## Context Usage\n\n| Category | Tokens |"),
    { resolve: "end_turn" },
  ];

  it("is dropped for /context, so the reply appears once", async () => {
    const provider = fakeAgent("claude", { prompts: [duplicated] });
    expect(rootTexts(await collect(provider.sendStream("/context", { chatId: "chat" })))).toEqual(["## Context Usage\n\n| Category | Tokens |"]);
  });

  it("is kept for any other prompt, and for Codex", async () => {
    const claude = fakeAgent("claude", { prompts: [duplicated] });
    expect(rootTexts(await collect(claude.sendStream("show the context", { chatId: "chat" })))).toHaveLength(2);
    const codex = fakeAgent("codex", { prompts: [duplicated] });
    expect(rootTexts(await collect(codex.sendStream("/context", { chatId: "chat" })))).toHaveLength(2);
  });

  it("keeps a different second message of a local-only command", async () => {
    const provider = fakeAgent("claude", { prompts: [[message("out-1", "first"), message("result-1", "second"), { resolve: "end_turn" }]] });
    expect(rootTexts(await collect(provider.sendStream("/context", { chatId: "chat" })))).toEqual(["first", "second"]);
  });
});
