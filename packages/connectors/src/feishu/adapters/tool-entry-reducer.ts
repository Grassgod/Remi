/**
 * The ACP tool_call / tool_call_update pairing state machine.
 *
 * This is the production reducer used by handleAgentStream to build the tool
 * entries a Feishu card renders. It is pure — no session, no I/O — so the
 * replay harnesses (tests/integration/replay-coverage.ts and
 * tests/manual/replay-fixture.ts) can drive the *same* logic and therefore
 * preview exactly what production renders. Do not fork it: any behaviour a
 * harness needs belongs here.
 */

import type {
  AgentAdapter,
  ToolCallUpdate,
  ToolCallProgressUpdate,
} from "@shared/contracts/acp-protocol.js";
import type { ToolEntry } from "../tool-formatters.js";
import { formatToolInputSummary } from "../tool-formatters.js";

/** A step the caller should render, e.g. `session.addStep(name, description)`. */
export interface ToolStep {
  name: string;
  description: string;
}

export interface ToolCallStarted {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  entry: ToolEntry;
}

export type ToolCallUpdated =
  /** Terminal frame: the tool finished (or failed). */
  | {
      kind: "finished";
      toolCallId: string;
      toolName: string;
      status: "completed" | "failed";
      durationMs?: number;
      resultPreview?: string;
      entry?: ToolEntry;
      step?: ToolStep;
    }
  /** First frame that carried usable arguments for a still-pending tool. */
  | {
      kind: "input";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      entry?: ToolEntry;
      step?: ToolStep;
    }
  /** Nothing to render: already seen, no arguments, or an own-form tool. */
  | { kind: "ignored"; toolCallId: string; toolName: string };

export interface ToolEntryReducer {
  /** Tool entries in call order; mutated in place as updates arrive. */
  readonly entries: ToolEntry[];
  /** Number of tool_call events seen. */
  readonly toolCount: number;
  onToolCall(update: ToolCallUpdate, thinkingBefore?: string): ToolCallStarted;
  onToolCallUpdate(update: ToolCallProgressUpdate): ToolCallUpdated;
}

export function createToolEntryReducer(adapter: AgentAdapter): ToolEntryReducer {
  const entries: ToolEntry[] = [];
  const toolNames = new Map<string, string>();
  const startTimes = new Map<string, number>();
  const seenInputs = new Set<string>();
  let toolCount = 0;

  return {
    entries,
    get toolCount() {
      return toolCount;
    },

    onToolCall(update, thinkingBefore = ""): ToolCallStarted {
      const toolName = adapter.resolveToolName(update);
      const input = adapter.extractToolInput(update);
      toolNames.set(update.toolCallId, toolName);
      startTimes.set(update.toolCallId, Date.now());
      toolCount++;
      const entry: ToolEntry = { name: toolName, input, status: "pending", thinkingBefore };
      entries.push(entry);
      return { toolCallId: update.toolCallId, toolName, input, entry };
    },

    onToolCallUpdate(update): ToolCallUpdated {
      const toolCallId = update.toolCallId;
      const toolName = toolNames.get(toolCallId) ?? adapter.resolveToolName(update);

      if (update.status === "completed" || update.status === "failed") {
        const startTime = startTimes.get(toolCallId);
        const durationMs = startTime ? Date.now() - startTime : undefined;
        startTimes.delete(toolCallId);
        toolNames.delete(toolCallId);
        seenInputs.delete(toolCallId);
        const resultPreview = adapter.extractResultPreview(update);
        const resolvedInput = adapter.extractToolInput(update);

        const entry = entries.findLast((e) => e.status === "pending");
        let step: ToolStep | undefined;
        if (entry) {
          entry.status = "done";
          entry.durationMs = durationMs;
          entry.resultPreview = resultPreview;
          // Latest wins: the terminal frame refines the args (claude sends
          // the command after the initial call) and enriches them (codex
          // collab lands agentsStates + the subagent's answer only here).
          // Keys the terminal frame omits survive from the initial input.
          if (resolvedInput) entry.input = { ...entry.input, ...resolvedInput };
          if (!entry.stepAdded) {
            entry.stepAdded = true;
            step = {
              name: entry.name,
              description: `${entry.name} ${formatToolInputSummary(entry.name, entry.input)}`.trim(),
            };
          }
        }
        return { kind: "finished", toolCallId, toolName, status: update.status, durationMs, resultPreview, entry, step };
      }

      if (seenInputs.has(toolCallId)) return { kind: "ignored", toolCallId, toolName };

      // These two render their own card form (approval / question), so the
      // progress frame must not also write a step for them.
      if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") {
        seenInputs.add(toolCallId);
        return { kind: "ignored", toolCallId, toolName };
      }

      const input = adapter.extractToolInput(update);
      if (!input || Object.keys(input).length === 0) return { kind: "ignored", toolCallId, toolName };
      seenInputs.add(toolCallId);

      const entry = entries.findLast((e) => e.status === "pending" && e.name === toolName);
      let step: ToolStep | undefined;
      if (entry && !entry.stepAdded) {
        entry.input = input;
        entry.stepAdded = true;
        step = {
          name: toolName,
          description: `${toolName} ${formatToolInputSummary(toolName, input)}`.trim(),
        };
      }
      return { kind: "input", toolCallId, toolName, input, entry, step };
    },
  };
}
