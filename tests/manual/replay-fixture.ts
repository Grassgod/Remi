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

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFeishuClient } from "@connectors/feishu/client.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { createAdapter } from "@acp/index.js";
import { formatToolInputSummary } from "@connectors/feishu/tool-formatters.js";
import { buildToolApprovalForm, buildAskQuestionForm, buildPlanReviewForm } from "@connectors/feishu/permission-ui.js";
import type { SessionUpdate, ToolCallUpdate, ToolCallProgressUpdate } from "@acp/protocol.js";
import { loadConfig as loadFeishuConfig } from "./_load-config.js";

// ── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(`Usage: bun run tests/manual/replay-fixture.ts <fixture-name> [--speed <multiplier>] [--chat <chat_id>]`);
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
const agentIdx = args.indexOf("--agent");
const agentType = agentIdx !== -1 ? (args[agentIdx + 1] ?? "claude") : "claude";

// ── Load config ─────────────────────────────────────────────

function loadConfig() {
  return loadFeishuConfig(chatIdOverride);
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

  const adapter = createAdapter(agentType);
  const baseDelay = speed === Infinity ? 0 : Math.round(200 / speed);
  const startTime = Date.now();

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
  const toolStartTimes = new Map<string, number>();
  const seenInputs = new Set<string>();
  const toolNames = new Map<string, string>();

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
        const tc = update as ToolCallUpdate;
        const name = adapter.resolveToolName(tc);
        const input = adapter.extractToolInput(tc);
        toolNames.set(tc.toolCallId, name);
        toolStartTimes.set(tc.toolCallId, Date.now());
        toolCount++;
        toolEntries.push({ name, input, status: "pending" });
        if (currentThinkingSegment.trim()) {
          session.addStep("_thinking", currentThinkingSegment.trim().replace(/\n{3,}/g, "\n\n"));
        }
        currentThinkingSegment = "";
        trailingThinkingFlushed = false;
        await session.updateStatus(formatToolStatus(name, input));
        console.log(`  🔧 tool_call: ${name}`);
        break;
      }
      case "tool_call_update": {
        const tc = update as ToolCallProgressUpdate;
        const name = toolNames.get(tc.toolCallId) ?? adapter.resolveToolName(tc);
        if (tc.status === "completed" || tc.status === "failed") {
          const st = toolStartTimes.get(tc.toolCallId);
          const durationMs = st ? Date.now() - st : undefined;
          toolStartTimes.delete(tc.toolCallId);
          const entry = toolEntries.findLast((e) => e.status === "pending");
          if (entry) {
            entry.status = "done";
            const resolvedInput = adapter.extractToolInput(tc);
            if (resolvedInput) entry.input = resolvedInput;
            if (!entry.stepAdded) {
              entry.stepAdded = true;
              const desc = `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}`.trim();
              session.addStep(entry.name, desc);
            }
          }
          await session.updateStatus("Thinking...");
          const dur = durationMs ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
          console.log(`  ✅ tool_done: ${name}${dur}`);
        } else if (!seenInputs.has(tc.toolCallId)) {
          const input = adapter.extractToolInput(tc);
          if (input && Object.keys(input).length > 0) {
            seenInputs.add(tc.toolCallId);
            const entry = toolEntries.findLast((e) => e.status === "pending" && e.name === name);
            if (entry && !entry.stepAdded) {
              entry.input = input;
              entry.stepAdded = true;
              const stepDesc = `${name} ${formatToolInputSummary(name, input)}`.trim();
              session.addStep(name, stepDesc);
              await session.updateStatus(formatToolStatus(name, input));
            }
            console.log(`  📥 tool_input: ${name} ${JSON.stringify(input).slice(0, 80)}`);
          }
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
