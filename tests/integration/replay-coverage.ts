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
import { createToolEntryReducer } from "@connectors/feishu/adapters/tool-entry-reducer.js";
import type { SessionUpdate, ToolCallUpdate, ToolCallProgressUpdate, ContentBlock } from "@shared/contracts/acp-protocol.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "acp");

/** Fixtures are recorded per agent; decode each one with its own adapter. */
function adapterFor(fixtureFile: string) {
  return createAdapter(fixtureFile.startsWith("codex-") ? "codex" : "claude");
}

interface CoverageResult {
  fixture: string;
  total: number;
  handled: Record<string, number>;
  unhandled: Record<string, number>;
  steps: string[];
  errors: string[];
}

function processFixture(filePath: string): CoverageResult {
  const fixture = filePath.split("/").pop()!;
  const notifications = JSON.parse(readFileSync(filePath, "utf-8")) as Array<Record<string, unknown>>;
  const handled: Record<string, number> = {};
  const unhandled: Record<string, number> = {};
  const steps: string[] = [];
  const errors: string[] = [];

  // Same state machine production renders with — see tool-entry-reducer.ts.
  const tools = createToolEntryReducer(adapterFor(fixture));
  let thinkingText = "";
  let contentText = "";
  let currentThinkingSegment = "";
  let trailingThinkingFlushed = false;

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
        tools.onToolCall(update as ToolCallUpdate, currentThinkingSegment);
        if (currentThinkingSegment.trim()) {
          steps.push(`[thinking] ${currentThinkingSegment.trim().slice(0, 60)}`);
        }
        currentThinkingSegment = "";
        trailingThinkingFlushed = false;
        break;
      }
      case "tool_call_update": {
        handled[su] = (handled[su] ?? 0) + 1;
        const result = tools.onToolCallUpdate(update as ToolCallProgressUpdate);

        if (result.kind === "finished") {
          if (result.step) steps.push(`[${result.status}] ${result.step.description}`);
          if (result.status === "failed") {
            errors.push(`tool_call_update failed: ${result.toolName} ${result.toolCallId}`);
          }
        } else if (result.kind === "input" && result.step) {
          steps.push(`[step] ${result.step.description}`);
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
    fixture,
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
