/**
 * The Chat composer's "/" menu (ADR 0025): the agent's own commands, as its
 * bridge advertised them, and the agent's platform skills. Pure logic: the
 * catalogue comes from `chatSlashCommandsOptions`, the skills from the agent.
 */
import {
  leadingSlashCommand,
  skillCommandName,
  slashCommandHandling,
  type ChatSlashCommandsResponse,
  type SlashCommandKind,
} from "@multiremi/contracts/slash-commands";

/** 「Agent 命令」 or 「技能」. */
export type SlashMenuGroup = "agent" | "skill";

export interface SlashMenuItem {
  /** Stable within one menu: `agent:<name>` or `skill:<skill id>`. */
  id: string;
  group: SlashMenuGroup;
  /** What the row names: the command, or the skill's own name. */
  label: string;
  /** Exactly what the message starts with when it is picked: `/compact`, `/deploy-prod`, Codex's `$deploy-prod`. */
  invocation: string;
  description: string;
  /** The argument hint, shown only as decoration; it is never sent. */
  hint: string | null;
  kind: SlashCommandKind;
  /** The platform skill, for a 「技能」 row. */
  skillId: string | null;
}

/** Where the agent's own commands stand: still reading, unreadable, or read. */
export type SlashMenuStatus = "loading" | "error" | "ready";

export interface SlashMenuModel {
  status: SlashMenuStatus;
  /** The catalogue's source once read: this Chat's, a preview from the user's last Chat with the agent, or none yet. */
  catalogue: ChatSlashCommandsResponse["state"] | null;
  provider: string | null;
  /** 「Agent 命令」 first, then 「技能」. */
  items: SlashMenuItem[];
}

export interface SlashMenuSkill {
  id: string;
  name: string;
  description?: string | null;
}

/** What a catalogue name is sent as: a Codex skill keeps its `$`, everything else follows a `/`. */
export function slashInvocation(name: string): string {
  return name.startsWith("$") ? name : `/${name}`;
}

/** What a platform skill is sent as when its agent has not advertised it: its command name (`$name` on Codex). */
export function platformSkillInvocation(provider: string | null | undefined, skillName: string): string {
  const name = skillCommandName(skillName);
  return provider === "codex" ? `$${name}` : `/${name}`;
}

/**
 * The menu: the catalogue's commands under 「Agent 命令」, the agent's
 * platform skills under 「技能」. A catalogue command that is one of those
 * skills (same `skill_id`, never the same name) moves into its skill's row
 * and lends it its invocation and hint.
 */
export function buildSlashMenu(input: {
  provider: string | null;
  status: SlashMenuStatus;
  response: ChatSlashCommandsResponse | null;
  skills: readonly SlashMenuSkill[];
}): SlashMenuModel {
  const commands = input.status === "ready" ? input.response?.commands ?? [] : [];
  const skillIds = new Set(input.skills.map((skill) => skill.id));
  const native = new Map(commands.flatMap((command) => command.skill_id && skillIds.has(command.skill_id)
    ? [[command.skill_id, command] as const] : []));
  const agentItems: SlashMenuItem[] = commands
    .filter((command) => !(command.skill_id && skillIds.has(command.skill_id)))
    .map((command) => ({
      id: `agent:${command.name}`, group: "agent", label: command.name, invocation: slashInvocation(command.name),
      description: command.description, hint: command.hint, kind: command.kind, skillId: null,
    }));
  const skillItems: SlashMenuItem[] = input.skills.map((skill) => {
    const advertised = native.get(skill.id);
    return {
      id: `skill:${skill.id}`, group: "skill", label: skill.name,
      invocation: advertised ? slashInvocation(advertised.name) : platformSkillInvocation(input.provider, skill.name),
      description: skill.description?.trim() || advertised?.description || "",
      hint: advertised?.hint ?? null, kind: "skill", skillId: skill.id,
    };
  });
  return {
    status: input.status,
    catalogue: input.status === "ready" ? input.response?.state ?? "none" : null,
    provider: input.provider,
    items: [...agentItems, ...skillItems],
  };
}

/** How well an item matches what was typed after the `/`, strongest first. */
export type SlashMatchStrength = "exact" | "prefix" | "word" | "contains" | "description";

const STRENGTH_ORDER: readonly SlashMatchStrength[] = ["exact", "prefix", "word", "contains", "description"];

export interface RankedSlashMenuItem {
  item: SlashMenuItem;
  /** Null for an empty query: every item shows, none is a match. */
  strength: SlashMatchStrength | null;
}

function matchStrength(item: SlashMenuItem, query: string): SlashMatchStrength | null {
  const name = item.invocation.replace(/^[/$]/, "").toLowerCase();
  const label = item.label.replace(/^[/$]/, "").toLowerCase();
  if (name === query || label === query) return "exact";
  if (name.startsWith(query) || label.startsWith(query)) return "prefix";
  const words = [...name.split(/[-_:.\s]+/), ...label.split(/[-_:.\s]+/)];
  if (words.some((word) => word.startsWith(query))) return "word";
  if (name.includes(query) || label.includes(query)) return "contains";
  if (item.description.toLowerCase().includes(query)) return "description";
  return null;
}

/**
 * The items that match `query` (what follows the `/`), groups in their fixed
 * order and, inside a group, exact → prefix → word start → contains →
 * description. A leading `/` or `$` in the query is ignored.
 */
export function rankSlashMenu(items: readonly SlashMenuItem[], query: string): RankedSlashMenuItem[] {
  const q = query.trim().replace(/^[/$]/, "").toLowerCase();
  if (!q) return items.map((item) => ({ item, strength: null }));
  const ranked = items.flatMap((item) => {
    const strength = matchStrength(item, q);
    return strength ? [{ item, strength }] : [];
  });
  const groupRank = (item: SlashMenuItem) => (item.group === "agent" ? 0 : 1);
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => groupRank(a.entry.item) - groupRank(b.entry.item)
      || STRENGTH_ORDER.indexOf(a.entry.strength) - STRENGTH_ORDER.indexOf(b.entry.strength)
      || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * The row Enter picks before any arrow key: the first exact match, else the
 * first prefix match. A weaker match is never picked by itself, so Enter
 * keeps its own meaning; with nothing typed after the `/`, nothing is picked.
 */
export function defaultSlashSelection(ranked: readonly RankedSlashMenuItem[]): number {
  const exact = ranked.findIndex((entry) => entry.strength === "exact");
  return exact >= 0 ? exact : ranked.findIndex((entry) => entry.strength === "prefix");
}

/** The command a message starts with, when Remi will not let the agent run it (ADR 0025 decision 8). */
export function blockedSlashCommand(provider: string | null | undefined, text: string): string | null {
  const command = leadingSlashCommand(text);
  return command && slashCommandHandling(provider, command.name) === "block" ? command.name : null;
}

/** Whether a message starts with a command: while the agent runs it is queued, never steered (ADR 0025 decision 6). */
export function startsWithSlashCommand(text: string): boolean {
  return leadingSlashCommand(text) !== null;
}
