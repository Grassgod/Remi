import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Globe,
  Bot,
  Sparkles,
  ListChecks,
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
  Bash: (i) => `$ ${truncate(shortPath(str(i.command)), MAX)}`,
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
  Agent: (i) => {
    const d = str(i.description ?? i.prompt ?? "");
    return d ? `"${truncate(d, 200)}"` : "";
  },
  Skill: (i) => str(i.skill ?? i.command ?? ""),
};

export function formatToolInputSummary(name: string, input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "";
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
};

export function toolIcon(name?: string): LucideIcon {
  return (name && ICONS[name]) || Wrench;
}
