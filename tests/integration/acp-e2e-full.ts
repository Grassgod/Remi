/**
 * ACP Full E2E Test Suite
 *
 * Tests multiple scenarios to collect comprehensive event data:
 * 1. Multi-tool: read + grep + edit
 * 2. Plan mode (TodoWrite)
 * 3. Agent/subagent spawn
 * 4. AskUserQuestion trigger
 * 5. Bash execution
 * 6. Session resume
 *
 * Usage: bun run tests/acp-e2e-full.ts [--agent claude|codex]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentIdx = process.argv.indexOf("--agent");
const agentType = agentIdx !== -1 ? (process.argv[agentIdx + 1] ?? "claude") : "claude";
const executableMap: Record<string, string> = {
  claude: "claude-agent-acp",
  codex: process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE || "codex-acp",
};
const agentExecutable = executableMap[agentType] ?? agentType;

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "acp");
mkdirSync(FIXTURE_DIR, { recursive: true });

// ── JSON-RPC Client ──────────────────────────────────────

class AcpTestClient {
  private proc: ChildProcess;
  private requestId = 0;
  private buffer = "";
  private pendingRequests = new Map<number, { method: string; resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
  private allEvents: Array<{ direction: string; ts: number; data: unknown }> = [];
  private notifications: Array<{ method: string; params: unknown }> = [];
  private agentRequests: Array<{ id: number; method: string; params: unknown }> = [];
  private sessionId: string | null = null;
  private label = "";

  constructor(executable: string = "claude-agent-acp") {
    console.log(`  [spawn] ${executable}`);
    this.proc = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log(`  [stderr] ${text.slice(0, 200)}`);
    });

    this.proc.on("exit", (code, signal) => {
      console.log(`  [exit] code=${code} signal=${signal}`);
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    this.allEvents.push({ direction: "recv", ts: Date.now(), data: msg });

    // Response to our request
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(pending.method as any); // cleanup
        this.pendingRequests.delete(msg.id);
        if ("error" in msg) {
          console.log(`  ← ERROR ${pending.method}: ${JSON.stringify(msg.error).slice(0, 150)}`);
          pending.reject(msg.error);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Agent → Client request
    if ("id" in msg && "method" in msg) {
      this.agentRequests.push({ id: msg.id, method: msg.method, params: msg.params });
      return;
    }

    // Notification
    if ("method" in msg && !("id" in msg)) {
      this.notifications.push({ method: msg.method, params: msg.params });
      const u = msg.params?.update;
      if (u) {
        const st = u.sessionUpdate;
        if (st === "agent_message_chunk") {
          const t = u.content?.text || u.content?.content?.[0]?.text || "";
          if (t.trim()) process.stdout.write(`  [content] ${t.slice(0, 100)}\n`);
        } else if (st === "agent_thought_chunk") {
          const t = u.content?.thought || u.content?.text || "";
          if (t.trim()) process.stdout.write(`  [thought] ${t.slice(0, 100)}\n`);
        } else if (st === "tool_call") {
          const toolName = u._meta?.claudeCode?.toolName || u._meta?.toolName || u.title;
          console.log(`  [tool_call] ${toolName} | title="${u.title}" kind=${u.kind} status=${u.status}`);
        } else if (st === "tool_call_update") {
          if (u.status === "completed" || u.status === "failed") {
            const toolName = u._meta?.claudeCode?.toolName || u._meta?.toolName || "";
            console.log(`  [tool_done] ${toolName} id=${u.toolCallId} status=${u.status}`);
          }
        } else if (st === "plan") {
          console.log(`  [plan] ${u.entries?.length ?? "?"} entries`);
        } else if (st === "usage_update") {
          if (u.cost) console.log(`  [cost] $${u.cost.amount}`);
        } else if (st === "current_mode_update") {
          console.log(`  [mode] ${JSON.stringify(u)}`);
        } else {
          console.log(`  [${st}] ${JSON.stringify(u).slice(0, 120)}`);
        }
      }
    }
  }

  private send(method: string, params?: unknown): number {
    const id = ++this.requestId;
    const msg = { jsonrpc: "2.0", id, method, params: params ?? {} };
    this.allEvents.push({ direction: "send", ts: Date.now(), data: msg });
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    return id;
  }

  private respondToAgent(id: number, result: unknown): void {
    const msg = { jsonrpc: "2.0", id, result };
    this.allEvents.push({ direction: "send", ts: Date.now(), data: msg });
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private respondToAgentError(id: number, code: number, message: string): void {
    const msg = { jsonrpc: "2.0", id, error: { code, message } };
    this.allEvents.push({ direction: "send", ts: Date.now(), data: msg });
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  async request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.send(method, params);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { method, resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  async prompt(text: string, timeoutMs = 180_000): Promise<unknown> {
    if (!this.sessionId) throw new Error("No session");
    console.log(`\n  → prompt: "${text.slice(0, 80)}..."`);
    this.notifications.length = 0;
    this.agentRequests.length = 0;

    const id = this.send("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { method: "session/prompt", resolve, reject });

      const pollInterval = setInterval(() => {
        // Auto-handle agent requests
        while (this.agentRequests.length > 0) {
          const req = this.agentRequests.shift()!;
          console.log(`  ⚡ agent-request: ${req.method}`);
          if (req.method === "session/request_permission") {
            const params = req.params as any;
            const options = params?.options;
            const toolCall = params?.toolCall;
            const toolName = toolCall?._meta?.claudeCode?.toolName || toolCall?._meta?.toolName || toolCall?.title || "";
            console.log(`    permission for: ${toolName}`);
            console.log(`    options: ${options?.map((o: any) => `${o.name}(${o.kind})`).join(", ")}`);
            // Auto-approve
            const allowOpt = options?.find((o: any) => o.kind === "allow_once" || o.kind === "allow_always");
            this.respondToAgent(req.id, {
              outcome: { selected: { optionId: allowOpt?.optionId || options?.[0]?.optionId } },
            });
            console.log(`    → approved (${allowOpt?.optionId})`);
          } else if (req.method.startsWith("fs/") || req.method.startsWith("terminal/")) {
            console.log(`    → rejected (not supported)`);
            this.respondToAgentError(req.id, -32601, `${req.method} not supported by test client`);
          } else {
            console.log(`    → rejected (unknown method)`);
            this.respondToAgentError(req.id, -32601, "Not supported");
          }
        }
      }, 50);

      const origResolve = this.pendingRequests.get(id)!.resolve;
      this.pendingRequests.get(id)!.resolve = (result) => {
        clearInterval(pollInterval);
        origResolve(result);
      };
      const origReject = this.pendingRequests.get(id)!.reject;
      this.pendingRequests.get(id)!.reject = (err) => {
        clearInterval(pollInterval);
        origReject(err);
      };

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          clearInterval(pollInterval);
          this.pendingRequests.delete(id);
          reject(new Error(`Prompt timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  async init(): Promise<unknown> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "remi-test", title: "Remi ACP Test", version: "0.1.0" },
    }, 30_000);
    return result;
  }

  async createSession(cwd?: string): Promise<string> {
    const result = await this.request("session/new", {
      cwd: cwd || process.cwd(),
      mcpServers: [],
    }, 30_000) as any;
    this.sessionId = result.sessionId;
    return this.sessionId!;
  }

  async closeSession(): Promise<void> {
    if (this.sessionId) {
      await this.request("session/close", { sessionId: this.sessionId }, 10_000).catch(() => {});
    }
  }

  getNotifications() { return this.notifications; }
  getUpdateCounts(): Record<string, number> {
    return this.notifications
      .filter(n => n.method === "session/update")
      .map(n => (n.params as any)?.update?.sessionUpdate)
      .reduce((acc: Record<string, number>, t: string) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  }

  saveFixtures(label: string): string {
    const path = join(FIXTURE_DIR, `${label}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(this.allEvents, null, 2));
    console.log(`  📁 Saved: ${path}`);
    this.label = label;
    return path;
  }

  saveScenarioFixtures(label: string): string {
    // Save only notifications from last prompt
    const path = join(FIXTURE_DIR, `${label}-notifications-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(this.notifications, null, 2));
    console.log(`  📁 Scenario: ${path}`);
    return path;
  }

  async shutdown(): Promise<void> {
    this.proc.stdin!.end();
    await new Promise(r => setTimeout(r, 2000));
    this.proc.kill();
  }

  getSessionId() { return this.sessionId; }
}

// ── Test Scenarios ────────────────────────────────────────

async function testMultiTool(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: Multi-Tool (grep + read) ═══");
  const result = await client.prompt(
    "Use Grep to find all files containing 'StreamEvent' in src/providers/, then tell me how many matches. Be brief, use only Grep."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testReadTool(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: Read Tool ═══");
  const result = await client.prompt(
    "Use the Read tool to read the file src/providers/base.ts and tell me how many lines it has. Be brief."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testPlanMode(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: Plan / TodoWrite ═══");
  const result = await client.prompt(
    "Create a todo list with 3 items using TodoWrite: 1) Read config file 2) Update version 3) Run tests. Just create the todo list, do NOT execute the tasks."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testAgentBash(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: Agent + Bash (subagent) ═══");
  const result = await client.prompt(
    "Use the Agent tool to spawn a subagent with description 'check disk usage' and prompt 'Run `df -h /` and `uptime` using Bash. Reply with a one-line summary.'. Wait for it to complete."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testAgentSpawn(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: Agent/Subagent Spawn ═══");
  const result = await client.prompt(
    "Use the Agent tool to spawn a subagent with description 'count TypeScript files' and prompt 'How many .ts files are in the src/ directory? Use Glob and count the results. Reply with just the number.'. Wait for it to complete."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testBashExecution(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: Bash Execution ═══");
  const result = await client.prompt(
    "Run `echo hello_from_acp_test` using the Bash tool. Tell me what the output was. Be brief."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testAskUserQuestion(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: AskUserQuestion ═══");
  const result = await client.prompt(
    "You need to ask me a clarifying question before proceeding. Use the AskUserQuestion tool to ask me 'Which database should we use?' with options: 'PostgreSQL', 'MySQL', 'SQLite'. Do NOT proceed without asking."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testEnterPlanMode(client: AcpTestClient, label: string) {
  console.log("\n═══ Test: EnterPlanMode ═══");
  const result = await client.prompt(
    "Use the EnterPlanMode tool to enter plan mode. You are planning a refactoring of the config system."
  );
  console.log(`  result: ${JSON.stringify(result)}`);
  console.log(`  events: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures(label);
}

async function testSessionResume(client: AcpTestClient) {
  console.log("\n═══ Test: Session Resume ═══");
  const sid = client.getSessionId();
  if (!sid) { console.log("  skip: no session"); return; }

  // Close and resume
  console.log(`  closing session ${sid}...`);
  await client.closeSession();
  await new Promise(r => setTimeout(r, 1000));

  console.log(`  resuming session ${sid}...`);
  try {
    const result = await client.request("session/resume", {
      sessionId: sid,
      cwd: process.cwd(),
      mcpServers: [],
    }, 30_000);
    console.log(`  resume result: ${JSON.stringify(result)}`);
  } catch (e) {
    console.log(`  resume error: ${e}`);
    // Try session/load as fallback
    try {
      const result2 = await client.request("session/load", {
        sessionId: sid,
        cwd: process.cwd(),
        mcpServers: [],
      }, 30_000);
      console.log(`  load result: ${JSON.stringify(result2)}`);
    } catch (e2) {
      console.log(`  load error: ${e2}`);
    }
  }

  console.log(`  events after resume: ${JSON.stringify(client.getUpdateCounts())}`);
  client.saveScenarioFixtures("session-resume");
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const prefix = agentType === "claude" ? "" : `${agentType}-`;
  console.log(`🚀 ACP Full E2E Test Suite (agent: ${agentType}, executable: ${agentExecutable})\n`);
  const client = new AcpTestClient(agentExecutable);
  await new Promise(r => setTimeout(r, 1500));

  // Init
  console.log("═══ Initialize ═══");
  const initResult = await client.init();
  console.log(`  capabilities: ${JSON.stringify(initResult, null, 2).slice(0, 300)}`);

  // Create session
  console.log("\n═══ Create Session ═══");
  const sid = await client.createSession();
  console.log(`  sessionId: ${sid}`);

  // Run scenarios
  const scenarios: Array<[string, (c: AcpTestClient, label: string) => Promise<void>]> = [
    [`${prefix}multi-tool`, testMultiTool],
    [`${prefix}read-tool`, testReadTool],
    [`${prefix}plan-todo`, testPlanMode],
    [`${prefix}agent-spawn`, testAgentSpawn],
    [`${prefix}agent-bash`, testAgentBash],
    [`${prefix}bash-exec`, testBashExecution],
    [`${prefix}ask-user`, testAskUserQuestion],
    [`${prefix}enter-plan`, testEnterPlanMode],
  ];

  for (const [label, fn] of scenarios) {
    try {
      await fn(client, label);
    } catch (e) {
      console.log(`  ❌ ${label} failed: ${e}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Session resume test (runs last since it closes the session)
  try {
    await testSessionResume(client);
  } catch (e) {
    console.log(`  ❌ session-resume failed: ${e}`);
  }

  // Save all events
  client.saveFixtures(`${prefix}full-suite`);

  // Cleanup
  await client.shutdown();
  console.log("\n✅ All tests complete.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
