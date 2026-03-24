/**
 * Aiden CLI NDJSON streaming protocol — message types + parser (no I/O).
 *
 * Handles Aiden's --stream-json output:
 * - Top-level types: "session", "event", "done"
 * - Event subtypes: message:create/append/update, toolcall:start/end, etc.
 */

// ── Parsed event types (Aiden stdout → Remi) ─────────────────

export interface AidenSessionMessage {
  kind: "session";
  sessionId: string;
  logFilePath?: string;
}

export interface AidenContentDelta {
  kind: "content_delta";
  id: string;
  text: string;
}

export interface AidenMessageUpdate {
  kind: "message_update";
  id: string;
  content: string;
  usage: AidenUsage;
}

export interface AidenToolCallStart {
  kind: "tool_use";
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AidenToolCallEnd {
  kind: "tool_result";
  toolUseId: string;
  name: string;
  success: boolean;
  output: string;
}

export interface AidenDone {
  kind: "done";
  status: string; // "completed" | "killed" | "failed"
}

export interface AidenError {
  kind: "error";
  error: string;
}

export interface AidenParseError {
  kind: "parse_error";
  rawLine: string;
  error: string;
}

export interface AidenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  contextLength: number | null;
}

export type AidenParsedMessage =
  | AidenSessionMessage
  | AidenContentDelta
  | AidenMessageUpdate
  | AidenToolCallStart
  | AidenToolCallEnd
  | AidenDone
  | AidenError
  | AidenParseError
  | { kind: "skip" };

// ── Parsing ──────────────────────────────────────────────────

/** Parse a single NDJSON line from Aiden --stream-json stdout. */
export function parseAidenLine(line: string): AidenParsedMessage {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch (e) {
    return {
      kind: "parse_error",
      rawLine: line.slice(0, 500),
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const topType = data.type as string | undefined;

  // ── Session init ─────────────────────────────────────────
  if (topType === "session") {
    return {
      kind: "session",
      sessionId: (data.sessionId as string) ?? "",
      logFilePath: data.logFilePath as string | undefined,
    };
  }

  // ── Done (stream termination) ────────────────────────────
  if (topType === "done") {
    return {
      kind: "done",
      status: (data.status as string) ?? "completed",
    };
  }

  // ── Error ────────────────────────────────────────────────
  if (topType === "error") {
    return {
      kind: "error",
      error: (data.message as string) ?? JSON.stringify(data),
    };
  }

  // ── Events ───────────────────────────────────────────────
  if (topType === "event") {
    const event = data.event as Record<string, unknown> | undefined;
    if (!event) return { kind: "skip" };

    const name = event.name as string | undefined;
    if (!name) return { kind: "skip" };

    // message:append — streaming text delta
    if (name === "message:append") {
      const delta = (event.delta as string) ?? "";
      if (!delta) return { kind: "skip" };
      return {
        kind: "content_delta",
        id: (event.id as string) ?? "",
        text: delta,
      };
    }

    // message:update — final full content + usage
    if (name === "message:update") {
      return {
        kind: "message_update",
        id: (event.id as string) ?? "",
        content: (event.content as string) ?? "",
        usage: extractUsage(event.usage as Record<string, unknown> | undefined),
      };
    }

    // message:create — start of a message (informational, skip)
    if (name === "message:create") {
      return { kind: "skip" };
    }

    // toolcall:start
    if (name === "toolcall:start") {
      let input: Record<string, unknown> = {};
      const rawInput = event.input as string | undefined;
      if (rawInput) {
        try { input = JSON.parse(rawInput) as Record<string, unknown>; } catch { /* leave empty */ }
      }
      return {
        kind: "tool_use",
        toolUseId: (event.id as string) ?? "",
        name: (event.tool as string) ?? "",
        input,
      };
    }

    // toolcall:end
    if (name === "toolcall:end") {
      return {
        kind: "tool_result",
        toolUseId: (event.id as string) ?? "",
        name: (event.tool as string) ?? "",
        success: (event.success as boolean) ?? false,
        output: truncate((event.output as string) ?? "", 1500),
      };
    }

    // All others: memory:load, agent:trace, task:performance, interaction:* → skip
    return { kind: "skip" };
  }

  // Unknown top-level type
  return { kind: "skip" };
}

// ── Helpers ──────────────────────────────────────────────────

function extractUsage(raw: Record<string, unknown> | undefined): AidenUsage {
  if (!raw) return { inputTokens: null, outputTokens: null, contextLength: null };
  return {
    inputTokens: (raw.input_tokens as number) ?? null,
    outputTokens: (raw.output_tokens as number) ?? null,
    contextLength: (raw.context_length as number) ?? null,
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}
