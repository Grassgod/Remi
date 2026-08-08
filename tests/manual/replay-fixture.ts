/**
 * Replay an ACP fixture recording through the Feishu streaming card pipeline.
 *
 * Usage:
 *   bun run tests/manual/replay-fixture.ts <fixture-name> [--speed <multiplier>] [--chat <chat_id>]
 *
 * Examples:
 *   bun run tests/manual/replay-fixture.ts bash-exec
 *   bun run tests/manual/replay-fixture.ts agent-bash --speed 2
 *   bun run tests/manual/replay-fixture.ts read-tool --speed instant
 *   bun run tests/manual/replay-fixture.ts agent-bash --chat oc_xxx
 */

import { basename, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { createFeishuClient } from "@connectors/feishu/client.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { createAdapter } from "@acp/index.js";
import { createToolEntryReducer } from "@connectors/feishu/adapters/tool-entry-reducer.js";
import { buildToolApprovalForm, buildAskQuestionForm, buildPlanReviewForm } from "@connectors/feishu/permission-ui.js";
import type { SessionUpdate, ToolCallUpdate, ToolCallProgressUpdate } from "@shared/contracts/acp-protocol.js";
import { loadConfig as loadFeishuConfig } from "./_load-config.js";

// ── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(`Usage: bun run tests/manual/replay-fixture.ts <fixture-name> [--speed <multiplier>] [--chat <chat_id>]`);
  console.log(`  --speed: 0.5, 1 (default), 2, 5, instant`);
  console.log(`  --chat: target chat_id (default: from trigger_user_ids in config)`);
  console.log(`  --agent: claude | codex (default: inferred from the fixture name)`);
  process.exit(0);
}

const fixtureName = args[0];
const speedIdx = args.indexOf("--speed");
const speedArg = speedIdx !== -1 ? args[speedIdx + 1] : "1";
const speed = speedArg === "instant" ? Infinity : parseFloat(speedArg) || 1;
const chatIdx = args.indexOf("--chat");
const chatIdOverride = chatIdx !== -1 ? args[chatIdx + 1] : undefined;
const agentIdx = args.indexOf("--agent");
const agentOverride = agentIdx !== -1 ? args[agentIdx + 1] : undefined;

/** Fixtures are recorded per agent; decode each one with its own adapter. */
function agentForFixture(fixtureFile: string): string {
  return agentOverride ?? (fixtureFile.startsWith("codex-") ? "codex" : "claude");
}

// ── Load config ─────────────────────────────────────────────

function loadConfig() {
  return loadFeishuConfig(chatIdOverride);
}

// ── Find fixture file ───────────────────────────────────────

/** Recordings are `<scenario>-notifications-<ts>.json`; the scenario is the name to type. */
function scenarioLabel(file: string): string {
  return file.replace(/-notifications(-\d+)?\.json$/, "").replace(/\.json$/, "");
}

function findFixture(name: string): string {
  const dir = join(process.cwd(), "tests", "fixtures", "acp");
  const all = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const files = all
    .filter((f) => f.startsWith(name))
    .sort()
    .reverse();
  if (files.length === 0) {
    const labels = [...new Set(all.map(scenarioLabel))].sort();
    throw new Error(
      `No fixture matching "${name}" in ${dir}\n` +
        `Available scenarios:\n${labels.map((l) => `  ${l}`).join("\n")}`,
    );
  }
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
  // Resolve the fixture before touching the DB/credentials, so a typo'd name
  // reports the available scenarios instead of a "run: remi login" detour.
  const fixturePath = findFixture(fixtureName);
  const config = loadConfig();
  const notifications = JSON.parse(readFileSync(fixturePath, "utf-8")) as Array<Record<string, unknown>>;

  console.log(`📊 ${notifications.length} events, speed: ${speed === Infinity ? "instant" : `${speed}x`}`);
  console.log(`💬 Target: ${config.chatId}`);

  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  const session = new FeishuStreamingSession(client, creds);

  // Start streaming card (send to user's P2P chat)
  await session.start(config.chatId, "open_id", { sessionId: `replay-${fixtureName}` });
  console.log(`🎬 Streaming card created`);

  const agentType = agentForFixture(basename(fixturePath));
  console.log(`🤖 Adapter: ${agentType}`);
  // Same state machine production renders with — see tool-entry-reducer.ts.
  const tools = createToolEntryReducer(createAdapter(agentType));
  const baseDelay = speed === Infinity ? 0 : Math.round(200 / speed);
  const startTime = Date.now();

  let thinkingText = "";
  let contentText = "";
  let currentThinkingSegment = "";
  let trailingThinkingFlushed = false;

  for (const notification of notifications) {
    const update = (notification as any).params?.update as SessionUpdate | undefined;
    if (!update) continue;

    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            thinkingText += b.text;
            currentThinkingSegment += b.text;
          }
        }
        await session.updateStatus("Thinking...");
        console.log(`  💭 thinking: "${(blocks[0] as any)?.text?.slice(0, 50) ?? ""}"`);
        break;
      }
      case "agent_message_chunk": {
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        for (const b of blocks) {
          if (b.type === "text" && b.text) contentText += b.text;
        }
        if (!trailingThinkingFlushed && currentThinkingSegment.trim()) {
          session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
          trailingThinkingFlushed = true;
        }
        await session.updateStatus("Writing...");
        await session.update(contentText);
        console.log(`  📝 content: "${(blocks[0] as any)?.text?.slice(0, 50) ?? ""}"`);
        break;
      }
      case "tool_call": {
        const { toolName, input } = tools.onToolCall(update as ToolCallUpdate, currentThinkingSegment);
        if (currentThinkingSegment.trim()) {
          session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
        }
        currentThinkingSegment = "";
        trailingThinkingFlushed = false;
        await session.updateStatus(formatToolStatus(toolName, input));
        console.log(`  🔧 tool_call: ${toolName}`);
        break;
      }
      case "tool_call_update": {
        const result = tools.onToolCallUpdate(update as ToolCallProgressUpdate);
        if (result.kind === "finished") {
          if (result.step) session.addStep(result.step.name, result.step.description);
          await session.updateStatus("Thinking...");
          const dur = result.durationMs ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : "";
          console.log(`  ✅ tool_done: ${result.toolName}${dur}`);
        } else if (result.kind === "input") {
          if (result.step) {
            session.addStep(result.step.name, result.step.description);
            await session.updateStatus(formatToolStatus(result.toolName, result.input));
          }
          console.log(`  📥 tool_input: ${result.toolName} ${JSON.stringify(result.input).slice(0, 80)}`);
        }
        break;
      }
    }

    // Handle synthetic permission request events in fixtures
    if ((update as any).sessionUpdate === "_permission_request") {
      const perm = update as any;
      const permType = perm.type as string; // "tool_approval" | "ask_question" | "plan_review"
      const actionId = `r${Date.now().toString(36)}`;
      const showDuration = speed === Infinity ? 3000 : Math.round(8000 / speed);

      if (permType === "tool_approval") {
        const form = buildToolApprovalForm(actionId, perm.toolName ?? "Bash", perm.inputSummary ?? "`$ echo test`", [
          { kind: "allow_once", name: "Allow", optionId: "allow_once" },
          { kind: "reject_once", name: "Reject", optionId: "reject_once" },
        ]);
        await session.updateStatus(`Waiting for ${perm.toolName ?? "Bash"} approval...`);
        await session.appendPermissionForm(form);
        console.log(`  🔒 permission: tool approval (${perm.toolName ?? "Bash"}) — showing ${showDuration}ms`);
        await Bun.sleep(showDuration);
        await session.removePermissionForm(actionId);
        await session.updateStatus("Running...");
        console.log(`  ✅ permission: approved (simulated)`);
      } else if (permType === "ask_question") {
        const questions = perm.questions ?? [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
        const form = buildAskQuestionForm(actionId, { questions });
        await session.updateStatus("Waiting for input...");
        await session.appendPermissionForm(form);
        console.log(`  💬 permission: ask question — showing ${showDuration}ms`);
        await Bun.sleep(showDuration);
        await session.removePermissionForm(actionId);
        await session.updateStatus("Running...");
        console.log(`  ✅ permission: answered (simulated)`);
      } else if (permType === "plan_review") {
        const form = buildPlanReviewForm(actionId, perm.planContent ?? "1. Step one\n2. Step two");
        await session.updateStatus("Waiting for approval...");
        await session.appendPermissionForm(form);
        console.log(`  📋 permission: plan review — showing ${showDuration}ms`);
        await Bun.sleep(showDuration);
        await session.removePermissionForm(actionId);
        await session.updateStatus("Running...");
        console.log(`  ✅ permission: approved (simulated)`);
      }
    }

    if (baseDelay > 0) await Bun.sleep(baseDelay);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const toolCount = tools.toolCount;
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
