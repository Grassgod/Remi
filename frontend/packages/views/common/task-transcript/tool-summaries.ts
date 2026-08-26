import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Globe,
  Bot,
  Sparkles,
  ListChecks,
  Hourglass,
  Wrench,
  type LucideIcon,
} from "lucide-react";

// Frontend port of the Feishu channel's per-tool input summariser
// (packages/connectors/src/feishu/tool-formatters.ts) — that lives in a server
// package the web bundle can't import, so the equivalent pure logic is
// duplicated here. Input is already redacted upstream (buildTimeline), so these
// only shorten for display.

const MAX = 160;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
function shortPath(p: string): string {
  if (!p) return p;
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}
/**
 * A shell command is not a path — shortPath() would eat every segment before the
 * last two and turn `... | head -30 > /dev/null` into `.../dev/null`. Show the
 * first line head-truncated, then how many lines were dropped. The `(+N)` suffix
 * stays symbols-only: it renders inside a font-mono command string, not prose.
 */
function commandSummary(command: string, max: number): string {
  const lines = command.trimEnd().split("\n");
  const dropped = lines.length - 1;
  const head = truncate(lines[0] ?? "", max);
  return dropped > 0 ? `${head} (+${dropped})` : head;
}

type Formatter = (input: Record<string, unknown>) => string;

const FORMATTERS: Record<string, Formatter> = {
  Read: (i) => {
    const path = shortPath(str(i.file_path));
    if (!path) return "";
    const offset = i.offset ? ` L${i.offset}` : "";
    return `${path}${offset}`;
  },
  Edit: (i) => shortPath(str(i.file_path)),
  Write: (i) => shortPath(str(i.file_path)),
  NotebookEdit: (i) => shortPath(str(i.notebook_path ?? i.file_path)),
  Bash: (i) => `$ ${commandSummary(str(i.command), MAX)}`,
  Grep: (i) => {
    const path = i.path ? ` in ${shortPath(str(i.path))}` : "";
    const glob = i.glob ? ` (${str(i.glob)})` : "";
    return `/${str(i.pattern)}/${path}${glob}`;
  },
  Glob: (i) => {
    const path = i.path ? ` in ${shortPath(str(i.path))}` : "";
    return `${shortPath(str(i.pattern))}${path}`;
  },
  WebFetch: (i) => truncate(str(i.url), 200),
  WebSearch: (i) => `"${truncate(str(i.query), 200)}"`,
  TodoWrite: (i) => {
    const todos = i.todos as Array<Record<string, unknown>> | undefined;
    if (!todos) return "";
    const done = todos.filter((t) => t.status === "completed").length;
    const active = todos.filter((t) => t.status === "in_progress").length;
    return `${todos.length} tasks (${done} done, ${active} active)`;
  },
  Agent: (i) => agentPromptSummary(i),
  Skill: (i) => str(i.skill ?? i.command ?? ""),
};

function agentPromptSummary(input: Record<string, unknown>): string {
  const d = str(input.description ?? input.prompt ?? "");
  return d ? `"${truncate(d, 200)}"` : "";
}

/**
 * Codex collab (subagent delegation) calls, recognized by input shape rather
 * than verb name: `spawnAgent` normalizes to `Agent` but `wait` — and any
 * send/close verb — passes through raw, and the generic fallback would print
 * the first short string it finds, i.e. a bare thread id. Every collab rawInput
 * carries senderThreadId + receiverThreadIds (verified in
 * tests/fixtures/acp/codex-collab-notifications-1786010059380.json); `prompt` is
 * null on `wait`, so it can't be the discriminator.
 */
export function isCollabInput(input?: Record<string, unknown>): boolean {
  return typeof input?.senderThreadId === "string" && Array.isArray(input.receiverThreadIds);
}

/**
 * Codex subagent activity (codex-acp >= 1.1.14): the inner activity that used
 * to be dropped entirely. A third shape, distinct from the `senderThreadId`
 * collab calls — `{ agentThreadId, agentPath, activityKind }`. Shape detection
 * is mandatory here: the ACP title is "Start subagent <name>", so the resolved
 * tool name varies per subagent and can never be a lookup key.
 */
export function isSubagentActivityInput(input?: Record<string, unknown>): boolean {
  return typeof input?.agentThreadId === "string" && typeof input.activityKind === "string";
}

/** Last segment of an agentPath — the subagent's name. */
export function subagentName(agentPath: unknown): string {
  const parts = str(agentPath).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Verb plus subagent name; the thread id never reaches a one-line summary. */
function subagentActivitySummary(input: Record<string, unknown>): string {
  const kind = str(input.activityKind);
  const name = subagentName(input.agentPath);
  if (kind && name) return `${kind} · ${name}`;
  return name || kind;
}

/** One agent's state inside a collab call's `agentsStates` map. */
export interface CollabAgentState {
  threadId: string;
  status: string;
  message?: string;
}

/** Read `agentsStates` defensively — a malformed map yields no chips, never a throw. */
export function collabAgentStates(input?: Record<string, unknown>): CollabAgentState[] {
  const states = input?.agentsStates;
  if (!states || typeof states !== "object" || Array.isArray(states)) return [];
  return Object.entries(states as Record<string, unknown>).map(([threadId, value]) => {
    const state = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const message = typeof state.message === "string" && state.message ? state.message : undefined;
    return { threadId, status: str(state.status ?? "unknown"), message };
  });
}

export function collabReceiverThreadIds(input?: Record<string, unknown>): string[] {
  const ids = input?.receiverThreadIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Counts, never ids. Only `completed` is terminal (`pendingInit` and the
 * camelCase `inProgress` are not), so anything else counts as running.
 */
function collabStateSummary(input: Record<string, unknown>): string {
  const states = collabAgentStates(input);
  const done = states.filter((s) => s.status === "completed").length;
  const running = states.length - done;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (parts.length > 0) return parts.join(" · ");
  return `waiting for ${collabReceiverThreadIds(input).length} agents`;
}

/**
 * Terminal Bash steps recorded before v0.2.20 can carry no command — the daemon
 * dropped it, leaving the input null or a `{terminal_id}`-only placeholder. A
 * running step can still receive its input, so only terminal gaps are legacy.
 */
export function isBashCommandMissing(
  name?: string,
  input?: Record<string, unknown>,
  running = false,
): boolean {
  return !running && name === "Bash" && str(input?.command).trim().length === 0;
}

/** ACP title fallback for a running call whose structured input has not arrived. */
export function formatRunningToolSummary(
  name?: string,
  meta?: Record<string, unknown>,
): string {
  const title = str(meta?.title).trim();
  if (!title || title === "Terminal") return "";
  return name === "Bash" ? formatToolInputSummary("Bash", { command: title }) : title;
}

export function formatToolInputSummary(name: string, input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "";
  // Shape before name: a delegation keeps the prompt summary (spawnAgent already
  // resolves to Agent), a prompt-less collab verb summarizes agent states, and
  // subagent activity is titled per subagent so it has no usable name key.
  if (isSubagentActivityInput(input)) return subagentActivitySummary(input);
  if (isCollabInput(input)) {
    return str(input.prompt) ? agentPromptSummary(input) : collabStateSummary(input);
  }
  const formatter = FORMATTERS[name];
  if (formatter) return formatter(input);
  // Default: first short string-valued field.
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0 && v.length < MAX) return v;
  }
  return "";
}

const ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  Read: FileText,
  Edit: Pencil,
  Write: Pencil,
  NotebookEdit: Pencil,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Agent: Bot,
  Skill: Sparkles,
  TodoWrite: ListChecks,
  EnterPlanMode: ListChecks,
  // Codex collab verb, lowercase as the bridge reports it.
  wait: Hourglass,
};

export function toolIcon(name?: string, input?: Record<string, unknown>): LucideIcon {
  // Subagent activity carries a per-subagent title, so only its input shape
  // identifies it.
  if (isSubagentActivityInput(input)) return Bot;
  return (name && ICONS[name]) || Wrench;
}
