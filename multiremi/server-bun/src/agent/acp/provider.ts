/**
 * AcpProvider — the single unified agent backend. Drives ANY ACP-speaking
 * agent through one code path:
 *   - codex  → codex-acp
 *   - claude → claude-agent-acp
 *   - hermes / kimi / kiro → native ACP CLIs
 * This replaces the Go server's 12 per-agent backends (pkg/agent/*).
 */

import { AcpClient } from "./client.js";
import { createAdapter } from "./adapters/index.js";
import type {
  SessionNotification,
  SessionUpdate,
  RequestPermissionParams,
  PermissionOutcome,
} from "./protocol.js";
import type {
  AgentExecuteOptions,
  AgentEvent,
  AgentResult,
  AgentBackend,
} from "../types.js";
import { createLogger } from "../../logger.js";

const slog = createLogger("acp-provider");

function textOf(
  content:
    | { type: string; text?: string }
    | ReadonlyArray<{ type: string; text?: string }>
    | null
    | undefined,
): string {
  // ACP sends a single ContentBlock per chunk; some agents send arrays.
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

function toEvent(update: SessionUpdate): AgentEvent {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk":
      return { kind: "text", text: textOf(update.content), raw: update };
    case "agent_thought_chunk":
      return { kind: "thought", text: textOf(update.content), raw: update };
    case "tool_call":
      return { kind: "tool_call", raw: update };
    case "tool_call_update":
      return { kind: "tool_update", raw: update };
    case "plan":
      return { kind: "plan", raw: update };
    default:
      return { kind: "other", raw: update };
  }
}

/** Auto-approve permission requests (bypassPermissions equivalent). */
async function autoApprove(p: RequestPermissionParams): Promise<PermissionOutcome> {
  const opt =
    p.options.find((o) => o.kind === "allow_once") ??
    p.options.find((o) => o.kind === "allow_always") ??
    p.options[0];
  return opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" };
}

export class AcpProvider implements AgentBackend {
  async *execute(
    opts: AgentExecuteOptions,
  ): AsyncGenerator<AgentEvent, AgentResult, void> {
    const adapter = createAdapter(opts.agentType);
    const sessionMeta = adapter.buildSessionMeta({
      model: opts.model ?? null,
      allowedTools: opts.allowedTools,
      permissionMode: opts.permissionMode ?? null,
    });

    // Bridge the client's onSessionUpdate callback into this generator.
    const queue: SessionUpdate[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const signal = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };

    const client = new AcpClient({
      executable: opts.executable ?? adapter.defaultExecutable(),
      args: opts.args ?? adapter.defaultArgs?.(),
      cwd: opts.cwd,
      env: opts.env,
      mcpServers: opts.mcpServers,
      sessionMeta,
      onSessionUpdate: (n: SessionNotification) => {
        queue.push(n.update);
        signal();
      },
      onPermissionRequest: opts.onPermissionRequest ?? autoApprove,
      log: (...a: unknown[]) => slog.debug(...a),
    });

    let text = "";
    try {
      await client.start();
      await client.initialize();
      const session = await client.newSession({ cwd: opts.cwd });
      const sessionId = session.sessionId;

      const promptResultP = client
        .prompt(sessionId, opts.prompt)
        .finally(() => {
          finished = true;
          signal();
        });

      for (;;) {
        while (queue.length > 0) {
          const ev = toEvent(queue.shift()!);
          if (ev.kind === "text") text += ev.text;
          yield ev;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Close the race: if work landed (or we finished) between the drain
          // above and installing `wake`, resolve immediately.
          if (queue.length > 0 || finished) signal();
        });
      }

      const pr = await promptResultP;
      return { stopReason: pr.stopReason, text, sessionId };
    } finally {
      await client.stop().catch(() => {});
    }
  }
}
