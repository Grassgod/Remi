/**
 * Slash commands in a turn's input (ADR 0025).
 *
 * The ACP bridges run a command only when the first text of the prompt starts
 * with it: codex-acp trims the first text block, reads `/`, skips whitespace
 * and takes the first word in lower case (`parseCommand`, dist/index.js
 * 38864-38877); claude-agent-acp passes the text to Claude Code, which runs a
 * leading `/name args`, and its own `/remote-control` handler trims the text
 * first (dist/acp-agent.js 191-202). `leadingSlashCommand` reads a text the way
 * the most lenient of them does, so a check built on it is never narrower than
 * a bridge.
 *
 * A few commands are harmful or meaningless when the agent runs on a hosted
 * runtime: they act on the runtime owner's account or settings, or switch the
 * model behind Remi. The daemon blocks them by putting a short note in front of
 * the text (`guardBlockedSlashCommand`), so the command is no longer at the
 * start and reaches the model as ordinary text. Others are only hidden from the
 * Chat menu. Both lists are per provider and follow what the pinned bridges
 * actually execute (claude-agent-acp 0.93.0 / Claude Code 2.1.303, codex-acp
 * 2.2.2, Antigravity 1.4.0); the reasons are in ADR 0025 decision 8.
 */

export type SlashCommandProvider = "claude" | "codex" | "antigravity";

export interface LeadingSlashCommand {
  /** The command name without the slash, in lower case: `compact`, `mcp:server:prompt`, `$deploy-prod`. */
  name: string;
  /** Everything after the name, trimmed: later lines included, as the bridges pass them on. */
  args: string;
}

/**
 * The command `text` starts with, or null. Leading whitespace (newlines
 * included) is skipped, and so is whitespace between the slash and the name,
 * as codex-acp does (`/ logout` runs `logout` there).
 */
export function leadingSlashCommand(text: string): LeadingSlashCommand | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1).trim();
  const name = rest.split(/\s+/, 1)[0] ?? "";
  if (!name) return null;
  return { name: name.toLowerCase(), args: rest.slice(name.length).trim() };
}

/**
 * Commands the daemon never lets a bridge run. Claude Code also runs a
 * command typed under one of its aliases (SDK `SlashCommand.aliases`), so the
 * aliases of the blocked commands in Claude Code 2.1.303 are listed as well:
 * `rc` (remote-control), `settings` (config), `reset` and `new` (clear),
 * `cost` and `stats` (usage).
 */
export const BLOCKED_SLASH_COMMANDS: Readonly<Record<SlashCommandProvider, readonly string[]>> = {
  claude: [
    "remote-control", "rc",
    "model", "effort", "fast",
    "config", "settings", "output-style", "autocompact", "auto-mode-setup",
    "clear", "reset", "new",
    "usage", "cost", "stats",
    "login", "logout",
  ],
  codex: ["logout", "status"],
  antigravity: ["logout", "usage"],
};

/** Commands the Chat menu does not offer; typed by hand, they still reach the agent. */
export const HIDDEN_SLASH_COMMANDS: Readonly<Record<SlashCommandProvider, readonly string[]>> = {
  claude: [
    "rename", "goal", "loop", "insights", "mcp", "reload-skills", "agents",
    "__remote-workflow", "workflow-launch-exec",
    "update-config", "fewer-permission-prompts", "plugin-authoring",
  ],
  codex: ["plan", "goal", "rename", "mcp"],
  antigravity: ["plan"],
};

const PROVIDERS = Object.keys(BLOCKED_SLASH_COMMANDS) as SlashCommandProvider[];

function knownProvider(provider: string | null | undefined): SlashCommandProvider | null {
  const value = String(provider ?? "").trim().toLowerCase();
  return (PROVIDERS as string[]).includes(value) ? value as SlashCommandProvider : null;
}

function listFor(lists: Readonly<Record<SlashCommandProvider, readonly string[]>>, provider: string | null | undefined): ReadonlySet<string> {
  const known = knownProvider(provider);
  // An unknown provider could be any of them: it gets every list.
  return new Set(known ? lists[known] : PROVIDERS.flatMap((name) => lists[name]));
}

/**
 * How Remi treats the command `name` (with or without its slash) for this
 * provider: `block`, `hide`, or null when it is offered and run as is. A `$`
 * name is a Codex skill mention, which no bridge runs as a command
 * (codex-acp `tryHandleCommand`, dist/index.js 38882), so it is never blocked.
 */
export function slashCommandHandling(provider: string | null | undefined, name: string): "block" | "hide" | null {
  const normalized = String(name ?? "").trim().replace(/^\//, "").toLowerCase();
  if (!normalized || normalized.startsWith("$")) return null;
  if (listFor(BLOCKED_SLASH_COMMANDS, provider).has(normalized)) return "block";
  if (listFor(HIDDEN_SLASH_COMMANDS, provider).has(normalized)) return "hide";
  return null;
}

/** The line put in front of a blocked command, so the model can say it did not run. */
export function blockedSlashCommandNote(name: string): string {
  return `[Remi] The user typed the command /${name}, which Remi does not run here. It reached you as text and did not run.`;
}

/**
 * `text` as it may be sent to the bridge: unchanged, or with the note line in
 * front when it starts with a command blocked for this provider. The note
 * starts with `[`, so no bridge reads a command at the start any more; the
 * user's own text follows after a blank line, untouched.
 */
export function guardBlockedSlashCommand(provider: string | null | undefined, text: string): string {
  const command = leadingSlashCommand(text);
  if (!command || slashCommandHandling(provider, command.name) !== "block") return text;
  return `${blockedSlashCommandNote(command.name)}\n\n${text}`;
}

/** The reply of a `/compact` turn that only compacted, in place of a reply the bridge never sends. */
export const COMPACT_COMMAND_REPLY = "Context compacted.";

/** Whether `text`, a turn's input as sent, is the `/compact` command (with or without instructions). */
export function isCompactCommand(text: string): boolean {
  return leadingSlashCommand(text)?.name === "compact";
}

/**
 * The command name of a Remi skill: the directory Remi installs it in, which
 * Remi also writes as the `name` of the generated `SKILL.md`, so `/name`
 * (Claude, Antigravity) or `$name` (Codex) invokes it. Lower case ASCII
 * letters, digits, `.`, `_` and `-`. A name with other letters (for example
 * Chinese) gets a short hash of the whole name, so two such skills never share
 * a directory.
 */
export function skillCommandName(name: string): string {
  const raw = String(name ?? "").trim();
  // No leading dot: never `.` or `..`, and never a hidden directory the provider skips.
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "skill";
  return hasNonAsciiText(raw) ? `${slug}-${shortHash(raw)}` : slug;
}

/** Whether `value` has characters outside ASCII, which a skill command name drops. */
export function hasNonAsciiText(value: string): boolean {
  return /[^\x00-\x7f]/.test(value);
}

/** FNV-1a over the UTF-16 code units, six hex digits: stable across the daemon and the browser. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}
