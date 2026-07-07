/**
 * ACP event coverage test — runs all fixture files through the feishu connector's
 * event processing logic (dry-run, no Feishu API calls) and reports which event
 * types are handled vs ignored.
 *
 * Usage: bun run tests/replay-coverage.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createAdapter } from "@acp/index.js";
import { formatToolInputSummary } from "../../src/connectors/feishu/sdk.js";
import type { SessionUpdate, ToolCallUpdate, ToolCallProgressUpdate, ContentBlock } from "@acp/protocol.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "acp");
const adapter = createAdapter("claude");

interface CoverageResult {
  fixture: string;
  total: number;
  handled: Record<string, number>;
  unhandled: Record<string, number>;
  steps: string[];
  errors: string[];
}

function processFixture(filePath: string): CoverageResult {
  const notifications = JSON.parse(readFileSync(filePath, "utf-8")) as Array<Record<string, unknown>>;
  const handled: Record<string, number> = {};
  const unhandled: Record<string, number> = {};
  const steps: string[] = [];
  const errors: string[] = [];

  const toolNames = new Map<string, string>();
  const toolStartTimes = new Map<string, number>();
  const seenInputs = new Set<string>();
  let thinkingText = "";
  let contentText = "";
  let currentThinkingSegment = "";
  let trailingThinkingFlushed = false;
  let toolCount = 0;

  interface Entry { name: string; input?: Record<string, unknown>; status: "pending" | "done"; stepAdded?: boolean; }
  const toolEntries: Entry[] = [];

  for (const n of notifications) {
    const update = (n as any).params?.update as SessionUpdate | undefined;
    if (!update) continue;

    const su = update.sessionUpdate;

    switch (su) {
      case "agent_thought_chunk": {
        handled[su] = (handled[su] ?? 0) + 1;
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        for (const b of blocks as ContentBlock[]) {
          if (b.type === "text" && b.text) {
            thinkingText += b.text;
            currentThinkingSegment += b.text;
          }
        }
        break;
      }
      case "agent_message_chunk": {
        handled[su] = (handled[su] ?? 0) + 1;
        const blocks = Array.isArray(update.content) ? update.content : [update.content];
        for (const b of blocks as ContentBlock[]) {
          if (b.type === "text" && b.text) contentText += b.text;
        }
        if (!trailingThinkingFlushed && currentThinkingSegment.trim()) {
          steps.push(`[thinking] ${currentThinkingSegment.trim().slice(0, 60)}`);
          trailingThinkingFlushed = true;
        }
        break;
      }
      case "tool_call": {
        handled[su] = (handled[su] ?? 0) + 1;
        const tc = update as ToolCallUpdate;
        const toolName = adapter.resolveToolName(tc);
        const input = adapter.extractToolInput(tc);
        toolNames.set(tc.toolCallId, toolName);
        toolStartTimes.set(tc.toolCallId, Date.now());
        toolCount++;
        toolEntries.push({ name: toolName, input, status: "pending" });
        if (currentThinkingSegment.trim()) {
          steps.push(`[thinking] ${currentThinkingSegment.trim().slice(0, 60)}`);
        }
        currentThinkingSegment = "";
        trailingThinkingFlushed = false;
        break;
      }
      case "tool_call_update": {
        handled[su] = (handled[su] ?? 0) + 1;
        const tc = update as ToolCallProgressUpdate;
        const toolName = toolNames.get(tc.toolCallId) ?? adapter.resolveToolName(tc);

        if (tc.status === "completed" || tc.status === "failed") {
          const entry = toolEntries.findLast((e) => e.status === "pending");
          if (entry) {
            entry.status = "done";
            const resolvedInput = adapter.extractToolInput(tc);
            if (resolvedInput) entry.input = resolvedInput;
            if (!entry.stepAdded) {
              entry.stepAdded = true;
              const desc = `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}`.trim();
              steps.push(`[${tc.status}] ${desc}`);
            }
          }
          if (tc.status === "failed") {
            errors.push(`tool_call_update failed: ${toolName} ${tc.toolCallId}`);
          }
        } else if (!seenInputs.has(tc.toolCallId)) {
          const input = adapter.extractToolInput(tc);
          if (input && Object.keys(input).length > 0) {
            seenInputs.add(tc.toolCallId);
            const entry = toolEntries.findLast((e) => e.status === "pending" && e.name === toolName);
            if (entry && !entry.stepAdded) {
              entry.input = input;
              entry.stepAdded = true;
              const desc = `${toolName} ${formatToolInputSummary(toolName, input)}`.trim();
              steps.push(`[step] ${desc}`);
            }
          }
        }
        break;
      }
      case "usage_update":
        handled[su] = (handled[su] ?? 0) + 1;
        break;
      case "user_message_chunk":
        handled[su] = (handled[su] ?? 0) + 1;
        break;
      case "plan":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        handled[su] = (handled[su] ?? 0) + 1;
        break;
      case "available_commands_update":
        unhandled[su] = (unhandled[su] ?? 0) + 1;
        break;
      default:
        unhandled[`unknown:${su}`] = (unhandled[`unknown:${su}`] ?? 0) + 1;
    }
  }

  return {
    fixture: filePath.split("/").pop()!,
    total: notifications.length,
    handled,
    unhandled,
    steps,
    errors,
  };
}

// ── Main ──────────────────────────────────────────────────

const files = readdirSync(FIXTURE_DIR)
  .filter((f) => f.includes("-notifications-") && f.endsWith(".json"))
  .sort();

// Deduplicate: keep only the latest per scenario prefix
const latest = new Map<string, string>();
for (const f of files) {
  const prefix = f.replace(/-notifications-\d+\.json$/, "");
  latest.set(prefix, f);
}

console.log(`\n🧪 ACP Event Coverage Test — ${latest.size} scenarios\n`);

let totalHandled = 0;
let totalUnhandled = 0;
const allHandledTypes = new Set<string>();
const allUnhandledTypes = new Set<string>();

for (const [scenario, file] of latest) {
  const result = processFixture(join(FIXTURE_DIR, file));
  const handledCount = Object.values(result.handled).reduce((a, b) => a + b, 0);
  const unhandledCount = Object.values(result.unhandled).reduce((a, b) => a + b, 0);
  totalHandled += handledCount;
  totalUnhandled += unhandledCount;

  for (const k of Object.keys(result.handled)) allHandledTypes.add(k);
  for (const k of Object.keys(result.unhandled)) allUnhandledTypes.add(k);

  const pct = result.total > 0 ? Math.round(handledCount / result.total * 100) : 0;
  console.log(`📂 ${scenario} (${result.total} events, ${pct}% handled)`);
  if (Object.keys(result.handled).length > 0) {
    console.log(`   ✅ ${Object.entries(result.handled).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  if (Object.keys(result.unhandled).length > 0) {
    console.log(`   ⚠️  ${Object.entries(result.unhandled).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  }
  if (result.steps.length > 0) {
    console.log(`   📋 ${result.steps.length} steps: ${result.steps.slice(0, 3).join(" → ")}${result.steps.length > 3 ? " →..." : ""}`);
  }
  if (result.errors.length > 0) {
    console.log(`   ❌ ${result.errors.join(", ")}`);
  }
  console.log();
}

console.log("═══ Summary ═══");
console.log(`Total events: ${totalHandled + totalUnhandled} (${totalHandled} handled, ${totalUnhandled} unhandled)`);
console.log(`Handled types: ${[...allHandledTypes].sort().join(", ")}`);
console.log(`Unhandled types: ${[...allUnhandledTypes].sort().join(", ") || "(none)"}`);
console.log(`Coverage: ${Math.round(totalHandled / (totalHandled + totalUnhandled) * 100)}%`);
