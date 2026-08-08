"use client";

import { Bot } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Markdown } from "../markdown";
import {
  collabAgentStates,
  collabReceiverThreadIds,
  subagentName,
} from "./tool-summaries";
import { shortThreadId } from "./event-format";
import { useT } from "../../i18n";

// ─── Codex collab (subagent delegation) detail ──────────────────────────────

/** Keys CollabDetail renders itself — kept out of the generic JSON block. */
export const COLLAB_RENDERED_KEYS = ["prompt", "senderThreadId", "receiverThreadIds", "agentsStates"];

/** Keys SubagentActivityDetail renders itself. */
export const SUBAGENT_ACTIVITY_KEYS = ["agentThreadId", "agentPath", "activityKind"];

/**
 * Codex subagent activity: which subagent, what it did. The thread id stays a
 * muted monospace line at the bottom, like the collab pane.
 */
export function SubagentActivityDetail({ input }: { input: Record<string, unknown> }) {
  const name = subagentName(input.agentPath);
  const kind = typeof input.activityKind === "string" ? input.activityKind : "";
  const path = typeof input.agentPath === "string" ? input.agentPath : "";
  const threadId = typeof input.agentThreadId === "string" ? input.agentThreadId : "";

  return (
    <div className="space-y-1.5 rounded bg-muted/40 border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-medium text-info">
          <Bot className="h-3 w-3" />
          {name || path}
        </span>
        {kind && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {kind}
          </span>
        )}
      </div>
      {path && <div className="font-mono text-[11px] text-muted-foreground break-all">{path}</div>}
      {threadId && (
        <div className="font-mono text-[10px] text-muted-foreground/70 break-all">{threadId}</div>
      )}
    </div>
  );
}

/**
 * A collab step's payload lives entirely in its input: the prompt, the per-agent
 * states, and — on a completed `wait` — each subagent's final answer in
 * `agentsStates[*].message`. The frames carry no output at all, so this is the
 * only place a delegation's result can come from.
 */
export function CollabDetail({ input }: { input: Record<string, unknown> }) {
  const { t } = useT("agents");
  const prompt = typeof input.prompt === "string" && input.prompt ? input.prompt : undefined;
  const states = collabAgentStates(input);
  const receivers = collabReceiverThreadIds(input);

  return (
    <div className="space-y-2">
      {prompt && (
        <div className="max-h-52 overflow-auto rounded bg-muted/40 border p-3 text-xs">
          <Markdown mode="minimal">{prompt}</Markdown>
        </div>
      )}

      {states.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {states.map((state) => (
            <span
              key={state.threadId}
              title={state.threadId}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                // Only `completed` is terminal; every other value (pendingInit,
                // inProgress, anything new) reads as in-progress.
                state.status === "completed" ? "bg-success/15 text-success" : "bg-info/15 text-info",
              )}
            >
              <span className="font-mono">{shortThreadId(state.threadId)}</span>
              {state.status}
            </span>
          ))}
        </div>
      )}

      {states
        .filter((state) => state.message)
        .map((state) => (
          <div key={`msg-${state.threadId}`} className="rounded bg-muted/40 border p-3 text-xs">
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">{shortThreadId(state.threadId)}</div>
            <div className="max-h-72 overflow-auto">
              <Markdown mode="minimal">{state.message ?? ""}</Markdown>
            </div>
          </div>
        ))}

      {receivers.length > 0 && (
        <div className="text-[10px] text-muted-foreground/70 font-mono break-all">
          {receivers.map((id) => (
            <div key={id}>{id}</div>
          ))}
        </div>
      )}

      {/* The ceiling, stated on the card: codex-acp drops subAgentActivity, so
          the subagent's own steps never reach this transcript. */}
      <div className="text-[10px] text-muted-foreground/70 italic">
        {t(($) => $.transcript.collab_activity_hidden)}
      </div>
    </div>
  );
}
