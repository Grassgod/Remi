import { CliError } from "./errors.js";

export type CliIdentity = "human" | "task" | "daemon" | "share";
export type CliOutputMode = "table" | "json" | "jsonl";
export type CliMutation = "read" | "write" | "destructive";
export type CliOptionType = "string" | "integer" | "boolean";
export type CliParsedScalar = string | number | boolean;
export type CliParsedValue = CliParsedScalar | CliParsedScalar[];

export type CommandSource =
  | { kind: "builtin" }
  | { kind: "plugin"; pluginId: string; pluginVersion: string };

export interface CliOptionSpec {
  name: string;
  aliases?: readonly string[];
  type: CliOptionType;
  description?: string;
  valueName?: string;
  required?: boolean;
  repeatable?: boolean;
  conflictsWith?: readonly string[];
  defaultValue?: CliParsedScalar;
}

export interface CliPositionalSpec {
  name: string;
  description?: string;
  required?: boolean;
  variadic?: boolean;
}

export interface CommandAlias {
  path: readonly string[];
  deprecatedSince?: string;
  replacement?: string;
  hidden?: boolean;
  /** Keep the alias in help/manifest inventory while a legacy parent owns dispatch. */
  dispatch?: boolean;
}

export interface CommandInvocation {
  spec: CommandSpec;
  matchedPath: readonly string[];
  alias: CommandAlias | null;
  rawArgs: readonly string[];
  positionals: readonly string[];
  options: Readonly<Record<string, CliParsedValue>>;
}

export interface CommandSpec {
  id: string;
  path: readonly string[];
  description: string;
  hidden?: boolean;
  aliases?: readonly CommandAlias[];
  capability?: string;
  auth?: readonly CliIdentity[];
  mutation?: CliMutation;
  outputs?: readonly CliOutputMode[];
  positionals?: readonly CliPositionalSpec[];
  options?: readonly CliOptionSpec[];
  parse?: "strict" | "passthrough";
  source?: CommandSource;
  run(invocation: CommandInvocation): Promise<void>;
}

export interface CommandInventoryEntry {
  id: string;
  path: readonly string[];
  description: string;
  hidden: boolean;
  aliases: readonly CommandAlias[];
  capability: string | null;
  auth: readonly CliIdentity[];
  mutation: CliMutation;
  outputs: readonly CliOutputMode[];
  parse: "strict" | "passthrough";
  positionals: readonly CliPositionalSpec[];
  options: readonly CliOptionSpec[];
  source: CommandSource;
}

interface RegisteredPath {
  key: string;
  path: readonly string[];
  spec: CommandSpec;
  alias: CommandAlias | null;
}

const TASK_PARITY_DENIED_COMMAND_IDS = new Set([
  "agent.role.set",
  "agent.supervisor.set",
  "autopilot.trigger.rotate-token",
  "autopilot.trigger.set-secret",
  "daemon.retire",
  "feishu.messages.create-issue",
  "feishu.proposals.approve",
  "feishu.proposals.reject",
  "feishu.endpoint.check",
  "feishu.endpoint.list",
  "feishu.source.add",
  "feishu.source.available-chats",
  "feishu.source.delete",
  "feishu.source.update",
  "lark.install.begin",
  "lark.installation.delete",
  "lark.binding.redeem",
  "lark.daemon.install",
  "lark.daemon.status",
  // Wiring a workspace to a channel, and creating an Issue from what arrived,
  // are the two things the Messaging API refuses a task token outright.
  "messaging.connection.add",
  "messaging.connection.authorization.get",
  "messaging.connection.authorization.start",
  "messaging.connection.check",
  "messaging.connection.delete",
  "messaging.connection.update",
  "messaging.message.create-issue",
  "messaging.proposal.approve",
  "messaging.proposal.reject",
  "messaging.source.add",
  "messaging.source.available-conversations",
  "messaging.source.delete",
  "messaging.source.update",
  "notification.channel.create",
  "notification.channel.delete",
  "notification.channel.update",
  "notification.delivery.retry",
  "platform.local.update",
  "runtime.archive-agents-and-delete",
  "runtime.create",
  "runtime.delete",
  "runtime.release.start",
  "runtime.command.run",
  "share.create",
  "share.delete",
  "share.extend",
  "share.get",
  "workspace.create",
  "workspace.bot-menu.publish",
  "workspace.bot-menu.publish-status",
  "workspace.bot-menu.update",
  "workspace.delete",
  "workspace.issue-topics.set",
  "workspace.leave",
  "workspace.organizer.update",
  "workspace.relay.reveal",
  "workspace.ssh-mesh.rotate",
  "workspace.ssh-mesh.update",
]);

const TASK_PARITY_DENIED_COMMAND_PREFIXES = [
  "billing.",
  "context.auth.",
  "invite.",
  "member.",
  "platform.settings.",
  "runtime.cloud.",
  "token.",
  // MUL-206: the Feishu concierge holds workspace-wide bot credentials and can
  // point the bot at any Agent, so it stays an owner/admin operation even for
  // the read commands — a task token must not learn which Agent answers, and
  // must certainly not be able to redeploy the bot.
  "workspace.feishu-bot.",
  // An agent must not be able to opt its own Issue-triggered wakeups in or out.
  "chat.issue.updates.",
];

function taskParityCommandSpec(spec: CommandSpec): CommandSpec {
  const humanAllowed = spec.auth?.includes("human") === true;
  const denied = TASK_PARITY_DENIED_COMMAND_IDS.has(spec.id)
    || TASK_PARITY_DENIED_COMMAND_PREFIXES.some((prefix) => spec.id.startsWith(prefix));
  return humanAllowed && !spec.auth?.includes("task") && !denied
    ? { ...spec, auth: [...(spec.auth ?? []), "task"] }
    : spec;
}

export interface CommandExecutionOptions {
  onDeprecatedAlias?: (alias: CommandAlias, spec: CommandSpec) => void;
}

export class CommandRegistry {
  private readonly specs = new Map<string, CommandSpec>();
  private readonly paths = new Map<string, RegisteredPath>();

  register(spec: CommandSpec): void {
    spec = taskParityCommandSpec(spec);
    validateCommandSpec(spec);
    if (this.specs.has(spec.id)) throw new Error(`CLI command id already registered: ${spec.id}`);
    const entries: RegisteredPath[] = [
      { key: pathKey(spec.path), path: [...spec.path], spec, alias: null },
      ...(spec.aliases ?? []).filter((alias) => alias.dispatch !== false).map((alias) => ({
        key: pathKey(alias.path),
        path: [...alias.path],
        spec,
        alias,
      })),
    ];
    for (const entry of entries) {
      const existing = this.paths.get(entry.key);
      if (existing) {
        throw new Error(`CLI command path already registered: ${entry.path.join(" ")} (${existing.spec.id})`);
      }
    }
    this.specs.set(spec.id, spec);
    for (const entry of entries) this.paths.set(entry.key, entry);
  }

  hasPath(path: readonly string[]): boolean {
    return this.paths.has(pathKey(path));
  }

  resolve(argv: readonly string[]): CommandInvocation | null {
    const matched = [...this.paths.values()]
      .filter((entry) => pathMatches(entry.path, argv))
      .sort((a, b) => b.path.length - a.path.length || Number(Boolean(a.alias)) - Number(Boolean(b.alias)))[0];
    if (!matched) return null;
    const rawArgs = argv.slice(matched.path.length);
    const parsed = matched.spec.parse === "passthrough"
      ? { positionals: [...rawArgs], options: {} }
      : parseCommandInput(rawArgs, matched.spec);
    return {
      spec: matched.spec,
      matchedPath: matched.path,
      alias: matched.alias,
      rawArgs,
      positionals: parsed.positionals,
      options: parsed.options,
    };
  }

  async execute(argv: readonly string[], options: CommandExecutionOptions = {}): Promise<boolean> {
    const invocation = this.resolve(argv);
    if (!invocation) return false;
    if (invocation.alias?.deprecatedSince) options.onDeprecatedAlias?.(invocation.alias, invocation.spec);
    await invocation.spec.run(invocation);
    return true;
  }

  inventory(): readonly CommandInventoryEntry[] {
    return [...this.specs.values()].map((spec) => ({
      id: spec.id,
      path: [...spec.path],
      description: spec.description,
      hidden: Boolean(spec.hidden),
      aliases: (spec.aliases ?? []).map((alias) => ({ ...alias, path: [...alias.path] })),
      capability: spec.capability ?? null,
      auth: [...(spec.auth ?? [])],
      mutation: spec.mutation ?? "read",
      outputs: [...(spec.outputs ?? [])],
      parse: spec.parse ?? "strict",
      positionals: (spec.positionals ?? []).map((positional) => ({ ...positional })),
      options: (spec.options ?? []).map((option) => ({
        ...option,
        aliases: option.aliases ? [...option.aliases] : undefined,
        conflictsWith: option.conflictsWith ? [...option.conflictsWith] : undefined,
      })),
      source: spec.source ?? { kind: "builtin" },
    }));
  }

  topLevelCommands(): readonly CommandInventoryEntry[] {
    return this.inventory().filter((entry) => entry.path.length === 1);
  }

  renderHelp(path: readonly string[] = [], programName = "remi"): string {
    const inventory = this.inventory();
    const children = inventory.filter((entry) =>
      !entry.hidden
      && entry.path.length > path.length
      && path.every((segment, index) => entry.path[index] === segment)
    );
    const directChildren = uniqueDirectChildren(children, path.length);
    const exact = inventory.find((entry) => samePath(entry.path, path));
    if (exact) {
      const spec = this.specs.get(exact.id)!;
      const usageParts = [programName, ...exact.path];
      for (const positional of spec.positionals ?? []) {
        const token = positional.variadic ? `<${positional.name}...>` : `<${positional.name}>`;
        usageParts.push(positional.required ? token : `[${token}]`);
      }
      if ((spec.options?.length ?? 0) > 0) usageParts.push("[options]");
      const lines = [`Usage: ${usageParts.join(" ")}`, "", exact.description];
      if (exact.source.kind === "plugin") {
        lines.push("", `Source: plugin ${exact.source.pluginId}@${exact.source.pluginVersion}`);
      }
      const visibleAliases = exact.aliases.filter((alias) => !alias.hidden);
      if (visibleAliases.length) {
        lines.push("", "Aliases:", ...visibleAliases.map((alias) => {
          const replacement = alias.replacement ? ` (use ${alias.replacement})` : "";
          return `  ${[programName, ...alias.path].join(" ")}${replacement}`;
        }));
      }
      if (spec.options?.length) {
        lines.push("", "Options:", ...spec.options.map((option) => {
          const names = [option.name, ...(option.aliases ?? [])].map((name) => `--${name}`).join(", ");
          const value = option.type === "boolean" ? "" : ` <${option.valueName ?? option.type}>`;
          return `  ${(names + value).padEnd(28)} ${option.description ?? ""}`.trimEnd();
        }));
      }
      if (directChildren.length) {
        lines.push("", ...renderCommandList(directChildren, path.length));
      }
      return lines.join("\n");
    }
    if (!directChildren.length) throw new CliError("not_found", `unknown command: ${path.join(" ")}`);
    return [
      `Usage: ${[programName, ...path, "<command>"].join(" ")}`,
      "",
      ...renderCommandList(directChildren, path.length),
    ].join("\n");
  }

  renderHelpForArgv(argv: readonly string[], programName = "remi"): string {
    const matched = [...this.paths.values()]
      .filter((entry) => pathMatches(entry.path, argv))
      .sort((a, b) => b.path.length - a.path.length || Number(Boolean(a.alias)) - Number(Boolean(b.alias)))[0];
    if (!matched) throw new CliError("not_found", `unknown command: ${argv.join(" ")}`);
    return this.renderHelp(matched.spec.path, programName);
  }

  supportsGeneratedHelp(argv: readonly string[]): boolean {
    const matched = [...this.paths.values()]
      .filter((entry) => pathMatches(entry.path, argv))
      .sort((a, b) => b.path.length - a.path.length || Number(Boolean(a.alias)) - Number(Boolean(b.alias)))[0];
    return Boolean(matched && !matched.spec.id.startsWith("legacy."));
  }
}

function uniqueDirectChildren(
  children: readonly CommandInventoryEntry[],
  parentLength: number,
): CommandInventoryEntry[] {
  const unique = new Map<string, CommandInventoryEntry>();
  for (const entry of children) {
    const childPath = entry.path.slice(0, parentLength + 1);
    if (!unique.has(pathKey(childPath))) unique.set(pathKey(childPath), entry);
  }
  return [...unique.values()];
}

function renderCommandList(entries: readonly CommandInventoryEntry[], parentLength: number): string[] {
  const names = entries.map((entry) => entry.path.slice(0, parentLength + 1).join(" "));
  const width = names.reduce((max, value) => Math.max(max, value.length), 0);
  return [
    "Commands:",
    ...entries.map((entry, index) => {
      const source = entry.source.kind === "plugin" ? ` [plugin:${entry.source.pluginId}]` : "";
      return `  ${names[index]!.padEnd(width)}  ${entry.description}${source}`;
    }),
  ];
}

function validateCommandSpec(spec: CommandSpec): void {
  if (!spec.id.trim()) throw new Error("CLI command id is required");
  validatePath(spec.path, `command ${spec.id}`);
  for (const alias of spec.aliases ?? []) validatePath(alias.path, `alias for ${spec.id}`);
  const optionNames = new Set<string>();
  for (const option of spec.options ?? []) {
    validateOptionName(option.name);
    for (const name of [option.name, ...(option.aliases ?? [])]) {
      validateOptionName(name);
      if (optionNames.has(name)) throw new Error(`Duplicate CLI option --${name} on ${spec.id}`);
      optionNames.add(name);
    }
  }
  for (const option of spec.options ?? []) {
    for (const conflicting of option.conflictsWith ?? []) {
      if (!(spec.options ?? []).some((candidate) => candidate.name === conflicting)) {
        throw new Error(`Unknown conflicting option --${conflicting} on ${spec.id}`);
      }
    }
  }
  let optionalSeen = false;
  for (const positional of spec.positionals ?? []) {
    if (!positional.required) optionalSeen = true;
    else if (optionalSeen) throw new Error(`Required positional follows an optional positional on ${spec.id}`);
  }
  const variadic = (spec.positionals ?? []).findIndex((positional) => positional.variadic);
  if (variadic >= 0 && variadic !== (spec.positionals?.length ?? 0) - 1) {
    throw new Error(`Variadic positional must be last on ${spec.id}`);
  }
}

function validatePath(path: readonly string[], label: string): void {
  if (!path.length) throw new Error(`CLI ${label} path is required`);
  for (const segment of path) {
    if (!segment.trim() || segment.startsWith("-") || /\s/.test(segment)) {
      throw new Error(`Invalid CLI ${label} path segment: ${JSON.stringify(segment)}`);
    }
  }
}

function validateOptionName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid CLI option name: ${JSON.stringify(name)}`);
}

function pathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function pathMatches(path: readonly string[], argv: readonly string[]): boolean {
  return path.length <= argv.length && path.every((segment, index) => argv[index] === segment);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => right[index] === segment);
}

function parseCommandInput(
  rawArgs: readonly string[],
  spec: CommandSpec,
): { positionals: string[]; options: Record<string, CliParsedValue> } {
  const definitions = new Map<string, CliOptionSpec>();
  for (const option of spec.options ?? []) {
    definitions.set(option.name, option);
    for (const alias of option.aliases ?? []) definitions.set(alias, option);
  }
  const options: Record<string, CliParsedValue> = {};
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]!;
    if (positionalOnly || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    const equals = arg.indexOf("=");
    let name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    let inlineValue = equals < 0 ? null : arg.slice(equals + 1);
    let negated = false;
    if (name.startsWith("no-") && !definitions.has(name)) {
      name = name.slice(3);
      negated = true;
    }
    const definition = definitions.get(name);
    if (!definition) throw new CliError("usage", `unknown option --${name} for ${spec.path.join(" ")}`);
    let value: CliParsedScalar;
    if (definition.type === "boolean") {
      if (inlineValue !== null) value = parseBoolean(inlineValue, definition.name);
      else if (!negated && isBooleanLiteral(rawArgs[index + 1])) {
        value = parseBoolean(rawArgs[index + 1]!, definition.name);
        index++;
      } else value = !negated;
    } else {
      if (negated) throw new CliError("usage", `--no-${name} is only valid for boolean options`);
      if (inlineValue === null) {
        const next = rawArgs[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new CliError("usage", `--${name} requires a value`);
        }
        inlineValue = next;
        index++;
      }
      value = definition.type === "integer"
        ? parseInteger(inlineValue, definition.name)
        : inlineValue;
    }
    setOptionValue(options, definition, value);
  }
  for (const definition of spec.options ?? []) {
    if (definition.required && !(definition.name in options)) {
      throw new CliError("usage", `--${definition.name} is required`);
    }
    if (definition.name in options) {
      for (const conflicting of definition.conflictsWith ?? []) {
        if (conflicting in options) {
          throw new CliError("usage", `--${definition.name} conflicts with --${conflicting}`);
        }
      }
    }
  }
  for (const definition of spec.options ?? []) {
    if (!(definition.name in options) && definition.defaultValue !== undefined) {
      options[definition.name] = definition.defaultValue;
    }
  }
  validatePositionals(positionals, spec);
  return { positionals, options };
}

function setOptionValue(
  options: Record<string, CliParsedValue>,
  definition: CliOptionSpec,
  value: CliParsedScalar,
): void {
  const current = options[definition.name];
  if (current === undefined) {
    options[definition.name] = definition.repeatable ? [value] : value;
    return;
  }
  if (!definition.repeatable) throw new CliError("usage", `--${definition.name} may only be provided once`);
  if (!Array.isArray(current)) throw new Error(`invalid repeated option state for --${definition.name}`);
  current.push(value);
}

function validatePositionals(positionals: readonly string[], spec: CommandSpec): void {
  const definitions = spec.positionals ?? [];
  const required = definitions.filter((definition) => definition.required).length;
  if (positionals.length < required) {
    const missing = definitions[positionals.length]?.name ?? "argument";
    throw new CliError("usage", `<${missing}> is required for ${spec.path.join(" ")}`);
  }
  if (!definitions.some((definition) => definition.variadic) && positionals.length > definitions.length) {
    throw new CliError("usage", `too many arguments for ${spec.path.join(" ")}`);
  }
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new CliError("usage", `--${name} must be true or false`);
}

function isBooleanLiteral(value: string | undefined): boolean {
  return value === "true" || value === "false" || value === "1" || value === "0";
}

function parseInteger(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new CliError("usage", `--${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliError("usage", `--${name} must be a safe integer`);
  return parsed;
}
