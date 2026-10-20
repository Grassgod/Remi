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

// ── The agent's command catalogue (ADR 0025 decisions 2-4) ──────────────────

/** Where a command comes from, as far as the bridge tells: a skill, an MCP prompt, or a command of unknown origin. */
export type SlashCommandKind = "command" | "skill" | "mcp_prompt";

/** One command of an agent's catalogue, as the daemon reports it and the API returns it. */
export interface SlashCommandEntry {
  /** What is sent after `/` (Codex skills keep their `$`): `compact`, `fix-issue`, `$deploy-prod`, `mcp:server:prompt`. */
  name: string;
  description: string;
  /** A free-text hint for the arguments, for display only; null when the command takes none. */
  hint: string | null;
  kind: SlashCommandKind;
  /** The Remi skill this command is, when the daemon installed it this turn (ADR 0025 decision 7). */
  skill_id?: string;
}

/** The latest catalogue of one agent session: the optional `available_commands` of `task.complete` / `task.fail`. */
export interface SlashCommandCatalogue {
  provider: string;
  /** ISO 8601: when the daemon read the catalogue, at the end of the attempt. */
  reported_at: string;
  commands: SlashCommandEntry[];
}

/** `GET /api/chat/slash-commands`: the catalogue the Chat menu shows, with the blocked and hidden commands taken out. */
export interface ChatSlashCommandsResponse {
  /**
   * `session`: reported by this Chat's own agent session (an empty list is a
   * real, empty catalogue); `preview`: the requesting user's latest other Chat
   * with this agent on the same provider and Runtime; `none`: nothing reported
   * yet (a daemon from before ADR 0025 never reports).
   */
  state: "session" | "preview" | "none";
  provider: string | null;
  reported_at: string | null;
  commands: SlashCommandEntry[];
}

/** Bounds on a reported catalogue (ADR 0025 decision 2). */
export const SLASH_COMMAND_LIMITS = {
  entries: 200,
  nameChars: 128,
  descriptionChars: 300,
  hintChars: 200,
  /** The whole `available_commands` value, JSON-encoded. */
  bytes: 32 * 1024,
} as const;

const SLASH_COMMAND_KINDS: readonly SlashCommandKind[] = ["command", "skill", "mcp_prompt"];

/**
 * A command from a bridge's `available_commands_update`, reduced to what Remi
 * keeps. No `_meta` and no path survives: only the `kind` the bridge marks and
 * the directory name of a skill's `SKILL.md`, which the daemon matches against
 * the skills it installed and never reports.
 */
export interface ObservedSlashCommand {
  name: string;
  description: string;
  hint: string | null;
  kind: SlashCommandKind;
  /** The directory a skill's `SKILL.md` sits in, from the AIR `skillPath`; null when the bridge gave none. */
  skillDir: string | null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A name that can follow a `/`: no whitespace (a bridge cannot invoke `/Git Commit`), no control characters. */
function invocableName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^\//, "");
  if (!name || name.length > SLASH_COMMAND_LIMITS.nameChars || /[\s\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The `availableCommands` of an `available_commands_update`, observed: names a
 * bridge could not run are dropped, the first of a repeated name wins, and
 * descriptions, hints and the count are cut to the reporting bounds. Null when
 * `raw` is not a list.
 */
export function observeAvailableCommands(raw: unknown): ObservedSlashCommand[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const observed: ObservedSlashCommand[] = [];
  for (const value of raw) {
    const entry = record(value);
    const name = invocableName(entry?.name);
    if (!entry || !name || seen.has(name)) continue;
    seen.add(name);
    const air = record(record(record(entry._meta)?.jetbrains)?.air);
    const skillPath = typeof air?.skillPath === "string" ? air.skillPath : "";
    // The directory of `<root>/<dir>/SKILL.md`; only its name is kept.
    const skillDir = /[\\/]SKILL\.md$/i.test(skillPath) ? skillPath.split(/[\\/]/).at(-2) ?? "" : "";
    const rawHint = record(entry.input)?.hint;
    const hint = typeof rawHint === "string" ? rawHint.trim() : "";
    observed.push({
      name,
      description: clip(typeof entry.description === "string" ? entry.description.trim() : "", SLASH_COMMAND_LIMITS.descriptionChars),
      hint: hint ? clip(hint, SLASH_COMMAND_LIMITS.hintChars) : null,
      kind: name.startsWith("$") || air?.kind === "skill" ? "skill" : name.startsWith("mcp:") ? "mcp_prompt" : "command",
      skillDir: skillDir || null,
    });
    if (observed.length >= SLASH_COMMAND_LIMITS.entries) break;
  }
  return observed;
}

/**
 * A catalogue within the bounds: valid entries only, with unknown keys
 * dropped, at most 200, and as many from the front as fit in 32 KiB. The
 * daemon applies it before it reports and the server before it stores.
 */
export function boundSlashCommands(values: readonly unknown[]): SlashCommandEntry[] {
  const seen = new Set<string>();
  const entries: SlashCommandEntry[] = [];
  for (const value of values) {
    const entry = record(value);
    const name = invocableName(entry?.name);
    if (!entry || !name || seen.has(name) || typeof entry.description !== "string"
      || (entry.hint !== null && entry.hint !== undefined && typeof entry.hint !== "string")
      || !SLASH_COMMAND_KINDS.includes(entry.kind as SlashCommandKind)
      || (entry.skill_id !== undefined && (typeof entry.skill_id !== "string" || !entry.skill_id.trim()))) continue;
    seen.add(name);
    const hint = typeof entry.hint === "string" && entry.hint.trim() ? clip(entry.hint.trim(), SLASH_COMMAND_LIMITS.hintChars) : null;
    entries.push({
      name,
      description: clip(entry.description.trim(), SLASH_COMMAND_LIMITS.descriptionChars),
      hint,
      kind: entry.kind as SlashCommandKind,
      ...(typeof entry.skill_id === "string" ? { skill_id: entry.skill_id.trim() } : {}),
    });
    if (entries.length >= SLASH_COMMAND_LIMITS.entries) break;
  }
  // Leave room for the envelope (provider, time) inside the byte budget.
  const budget = SLASH_COMMAND_LIMITS.bytes - 256;
  const encoder = new TextEncoder();
  let size = 2;
  let kept = 0;
  for (const entry of entries) {
    size += encoder.encode(JSON.stringify(entry)).length + 1;
    if (size > budget) break;
    kept++;
  }
  return entries.slice(0, kept);
}

/** The commands a Chat menu offers: everything but the blocked and hidden ones for this provider. */
export function visibleSlashCommands(provider: string | null | undefined, commands: readonly SlashCommandEntry[]): SlashCommandEntry[] {
  return commands.filter((command) => slashCommandHandling(provider, command.name) === null);
}
