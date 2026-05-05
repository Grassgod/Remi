/**
 * Replay an ACP fixture recording through the Feishu streaming card pipeline.
 *
 * Usage:
 *   bun run scripts/replay-fixture.ts <fixture-name> [--speed <multiplier>] [--chat <chat_id>]
 *
 * Examples:
 *   bun run scripts/replay-fixture.ts bash-exec
 *   bun run scripts/replay-fixture.ts agent-bash --speed 2
 *   bun run scripts/replay-fixture.ts read-tool --speed instant
 *   bun run scripts/replay-fixture.ts agent-bash --chat oc_xxx
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFeishuClient } from "../src/connectors/feishu/client.js";
import { FeishuStreamingSession } from "../src/connectors/feishu/streaming.js";
import { createMapperState, mapSessionUpdate } from "../src/providers/acp/event-mapper.js";
import { createAdapter } from "../src/providers/acp/adapters/index.js";
import { formatToolInputSummary } from "../src/connectors/feishu/tool-formatters.js";
import type { SessionUpdate } from "../src/providers/acp/protocol.js";
import type { StreamEvent, AgentResponse } from "../src/providers/base.js";

// ── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(`Usage: bun run scripts/replay-fixture.ts <fixture-name> [--speed <multiplier>] [--chat <chat_id>]`);
  console.log(`  --speed: 0.5, 1 (default), 2, 5, instant`);
  console.log(`  --chat: target chat_id (default: from trigger_user_ids in config)`);
  process.exit(0);
}

const fixtureName = args[0];
const speedIdx = args.indexOf("--speed");
const speedArg = speedIdx !== -1 ? args[speedIdx + 1] : "1";
const speed = speedArg === "instant" ? Infinity : parseFloat(speedArg) || 1;
const chatIdx = args.indexOf("--chat");
const chatIdOverride = chatIdx !== -1 ? args[chatIdx + 1] : undefined;

// ── Load config ─────────────────────────────────────────────

function loadConfig(): { appId: string; appSecret: string; domain: string; chatId: string } {
  const configPaths = [
    join(process.cwd(), "remi.toml"),
    join(process.env.HOME || "/home", ".remi", "remi.toml"),
  ];

  let tomlContent = "";
  for (const p of configPaths) {
    try { tomlContent = readFileSync(p, "utf-8"); break; } catch {}
  }
  if (!tomlContent) throw new Error("remi.toml not found");

  const appIdMatch = tomlContent.match(/app_id\s*=\s*"([^"]+)"/);
  const appSecretMatch = tomlContent.match(/app_secret\s*=\s*"([^"]+)"/);
  const domainMatch = tomlContent.match(/domain\s*=\s*"([^"]+)"/);
  const triggerMatch = tomlContent.match(/trigger_user_ids\s*=\s*\[\s*"([^"]+)"/);

  if (!appIdMatch || !appSecretMatch) throw new Error("Feishu credentials not found in remi.toml");

  return {
    appId: appIdMatch[1],
    appSecret: appSecretMatch[1],
    domain: domainMatch?.[1] ?? "feishu",
    chatId: chatIdOverride || triggerMatch?.[1] || "",
  };
}

// ── Find fixture file ───────────────────────────────────────

function findFixture(name: string): string {
  const dir = join(process.cwd(), "tests", "fixtures", "acp");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(name) && f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) throw new Error(`No fixture matching "${name}" in ${dir}`);
  console.log(`📂 Fixture: ${files[0]}`);
  return join(dir, files[0]);
}

// ── Format tool status for status bar ───────────────────────

function formatToolStatus(name: string, input?: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const trunc = (t: string, max: number) => t.length <= max ? t : t.slice(0, max - 3) + "...";
  switch (name) {
    case "Read": return `Reading ${trunc(s(input?.file_path), 200)}...`;
    case "Bash": return `Running: ${trunc(s(input?.command).split("\n")[0], 200)}`;
    case "Grep": return `Searching: ${trunc(s(input?.pattern), 200)}...`;
    case "Edit": case "Write": return `Editing ${trunc(s(input?.file_path), 200)}...`;
    case "Agent": return `Agent: ${trunc(s(input?.description ?? input?.prompt), 200)}...`;
    default: return `Tool: ${name}...`;
  }
}

// ── Main replay logic ───────────────────────────────────────

async function main() {
  const config = loadConfig();
  const fixturePath = findFixture(fixtureName);
  const notifications = JSON.parse(readFileSync(fixturePath, "utf-8")) as Array<Record<string, unknown>>;

  console.log(`📊 ${notifications.length} events, speed: ${speed === Infinity ? "instant" : `${speed}x`}`);
  console.log(`💬 Target: ${config.chatId}`);

  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  const session = new FeishuStreamingSession(client, creds);

  // Start streaming card (send to user's P2P chat)
  await session.start(config.chatId, "open_id", { sessionId: `replay-${fixtureName}` });
  console.log(`🎬 Streaming card created`);

  const state = createMapperState();
  const adapter = createAdapter("claude");

  const baseDelay = speed === Infinity ? 0 : Math.round(200 / speed);

  let thinkingText = "";
  let contentText = "";
  let currentThinkingSegment = "";
  let trailingThinkingFlushed = false;
  let toolCount = 0;

  interface ToolEntry {
    name: string;
    input?: Record<string, unknown>;
    status: "pending" | "done";
    stepAdded?: boolean;
  }
  const toolEntries: ToolEntry[] = [];

  for (const notification of notifications) {
    const update = (notification as any).params?.update as SessionUpdate | undefined;
    if (!update) continue;

    const events = mapSessionUpdate(update, state, adapter);

    for (const event of events) {
      switch (event.kind) {
        case "thinking_delta":
          thinkingText += event.text;
          currentThinkingSegment += event.text;
          await session.updateStatus("Thinking...");
          console.log(`  💭 thinking: "${event.text.slice(0, 50)}..."`);
          break;

        case "content_delta":
          contentText += event.text;
          if (!trailingThinkingFlushed && currentThinkingSegment.trim()) {
            session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
            trailingThinkingFlushed = true;
          }
          await session.updateStatus("Writing...");
          await session.update(contentText);
          console.log(`  📝 content: "${event.text.slice(0, 50)}..."`);
          break;

        case "tool_use":
          toolCount++;
          toolEntries.push({
            name: event.name,
            input: event.input,
            status: "pending",
          });
          if (currentThinkingSegment.trim()) {
            session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
          }
          currentThinkingSegment = "";
          trailingThinkingFlushed = false;
          await session.updateStatus(formatToolStatus(event.name, event.input));
          console.log(`  🔧 tool_use: ${event.name}`);
          break;

        case "tool_input_update": {
          const entry = toolEntries.findLast((e) => e.status === "pending" && e.name === event.name);
          if (entry && !entry.stepAdded) {
            entry.input = event.input;
            entry.stepAdded = true;
            const stepDesc = `${event.name} ${formatToolInputSummary(event.name, event.input)}`.trim();
            session.addStep(event.name, stepDesc);
            await session.updateStatus(formatToolStatus(event.name, event.input));
          }
          console.log(`  📥 tool_input: ${event.name} ${JSON.stringify(event.input).slice(0, 80)}`);
          break;
        }

        case "tool_result": {
          const entry = toolEntries.findLast((e) => e.status === "pending");
          if (entry) {
            entry.status = "done";
            if (event.input) entry.input = event.input;
            if (!entry.stepAdded) {
              entry.stepAdded = true;
              const desc = `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}`.trim();
              session.addStep(entry.name, desc);
            }
          }
          await session.updateStatus("Thinking...");
          const dur = event.durationMs ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : "";
          console.log(`  ✅ tool_result: ${event.name}${dur}`);
          break;
        }

        case "error":
          console.log(`  ❌ error: ${event.error}`);
          break;
      }

      if (baseDelay > 0) await Bun.sleep(baseDelay);
    }
  }

  // Close with final card
  const elapsed = Math.round((Date.now() - state.promptStartTime) / 1000);
  console.log(`\n🏁 Replay complete: ${toolCount} tools, ${elapsed}s elapsed`);
  console.log(`   Thinking: ${thinkingText.length} chars, Content: ${contentText.length} chars`);

  await session.close({
    finalText: contentText || undefined,
    thinking: thinkingText || null,
    trailingThinking: currentThinkingSegment || undefined,
    toolCount,
    stats: `${elapsed}s · ${toolCount} tools · replay`,
  });

  console.log("✨ Done — final card rendered");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
