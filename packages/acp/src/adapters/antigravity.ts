/**
 * Antigravity adapter: Google's official ACP server (`antigravity-acp`).
 * Launch, environment and the provider-side quirks live in the access config
 * (`../access/antigravity.ts`); tool reading is shared with the trace
 * translator through `./trace-vendor.ts`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentSessionOptions,
  AskUserQuestionData,
  NewSessionMeta,
  ToolCallProgressUpdate,
  ToolCallUpdate,
} from "@shared/contracts/acp-protocol.js";
import { mapAntigravityPermissionMode } from "../access/antigravity.js";
import { ANTIGRAVITY_SERVER_BINARY } from "../antigravity-install.js";
import { antigravityToolName, normalizeToolInput } from "./trace-vendor.js";

/** The runtime-context file is capped at 24 KiB; anything larger is not ours. */
const MAX_HOME_INSTRUCTIONS_BYTES = 256 * 1024;

function homeInstructions(home: unknown): string | null {
  if (typeof home !== "string" || !home) return null;
  const file = join(home, "AGENTS.md");
  try {
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > MAX_HOME_INSTRUCTIONS_BYTES) return null;
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Server 1.4.0 lets the model choose each shell command's working directory,
 * and without this note models picked `$GEMINI_HOME/antigravity-cli/skills`
 * (a directory the server creates) instead of the session cwd, whatever the
 * workspace trust (live probe, risk R5). Naming the cwd fixes the choice.
 */
function workingDirectoryNote(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !cwd) return null;
  return `The working directory of this session is ${cwd}. Run every shell command in that directory `
    + "(set it as the command's working directory) unless the task names another directory.";
}

/**
 * Server 1.4.0 keeps a turn open while a background command runs and ignores
 * `session/cancel` meanwhile (live probe); the provider's stall watchdog is
 * the backstop when the model backgrounds one anyway.
 */
export const ANTIGRAVITY_FOREGROUND_NOTE = "Run shell commands in the foreground and wait for them to finish; never leave a command "
  + "running in the background. If a command could run for a long time, say so instead of starting it in the background.";

/**
 * No `steering`: server 1.4.0 advertises none, and a second `session/prompt`
 * while one runs fails ("Concurrent receive_steps() calls are not
 * supported", live probe R6). A steer therefore always cancels and re-prompts
 * (ADR 0020).
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly agentType = "antigravity";
  /** The server returns no prompt usage; shim observations are per request. */
  readonly promptUsageSettleScope = "last-request" as const;

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    return antigravityToolName(update as unknown as Record<string, unknown>) ?? update.title ?? "tool";
  }

  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    const input = normalizeToolInput(update.rawInput) ?? {};
    const location = update.locations?.[0];
    if (location?.path && input.path === undefined) input.path = location.path;
    return Object.keys(input).length ? input : undefined;
  }

  extractResultPreview(update: ToolCallProgressUpdate): string | undefined {
    const parts: string[] = [];
    if (typeof update.rawOutput === "string") parts.push(update.rawOutput);
    else if (update.rawOutput && typeof update.rawOutput === "object") {
      const output = update.rawOutput as Record<string, unknown>;
      const text = output.formatted_output ?? output.combinedOutput;
      parts.push(typeof text === "string" ? text : JSON.stringify(output));
    }
    for (const item of update.content ?? []) {
      if (item.type === "content" && item.content.type === "text") parts.push(item.content.text);
      else if (item.type === "diff") parts.push(`diff: ${item.path}`);
    }
    const preview = parts.join("\n").trim();
    return preview ? preview.slice(0, 800) : undefined;
  }

  /** Questions arrive as `session/request_permission`; the provider turns them into elicitations. */
  extractAskUserQuestion(_toolCall: ToolCallProgressUpdate): AskUserQuestionData | null {
    return null;
  }

  isExitPlanMode(_toolCall: ToolCallProgressUpdate): boolean {
    return false;
  }

  mapPermissionMode(mode: string): string[] {
    return mapAntigravityPermissionMode(mode);
  }

  /**
   * `_meta.antigravity.systemPrompt.append` (advertised in `initialize`
   * `_meta.antigravity.systemPrompt.append`; read on new, load and resume):
   * the session notes (working directory, foreground commands), Remi's system prompt, then the
   * runtime-context instructions the daemon writes to `$GEMINI_HOME/AGENTS.md`.
   * Server 1.4.0 reads neither that file nor the cwd's AGENTS.md on its own
   * (live probe), so nothing is duplicated.
   */
  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta | undefined {
    const plugins = options.pluginPaths;
    if (Array.isArray(plugins) && plugins.length) throw new Error("Antigravity does not support Remi Agent Plugins");
    if (options.allowedTools?.length) {
      console.warn(`[acp:antigravity] ignoring allowedTools (${options.allowedTools.join(", ")}): Remi tool names do not apply to Antigravity`);
    }
    const notes = [workingDirectoryNote(options.cwd), ANTIGRAVITY_FOREGROUND_NOTE].filter(Boolean).join("\n");
    const append = [notes, options.systemPrompt?.trim(), homeInstructions(options.home)].filter(Boolean).join("\n\n");
    return { antigravity: { systemPrompt: { append } } };
  }

  defaultExecutable(): string {
    return ANTIGRAVITY_SERVER_BINARY;
  }
}
