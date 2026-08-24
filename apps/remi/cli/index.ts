/**
 * Remi CLI — Command registry and dispatcher.
 *
 * Maps subcommand names to handler modules.
 * Each handler exports: async run(args: string[]): Promise<void>
 */

import { VERSION } from "@shared/version.js";
import { CommandRegistry, type CommandInventoryEntry, type CommandSource } from "./core/command-registry.js";
import { agentExtensionCommandSpecs } from "./commands/agent-extensions.js";
import { contextCommandSpec } from "./commands/context.js";
import { collaborationCommandSpecs } from "./commands/collaboration.js";
import { inviteCommandSpecs } from "./commands/invite.js";
import { knowledgeCommandSpecs } from "./commands/knowledge.js";
import { memberCommandSpecs } from "./commands/member.js";
import { operationsCommandSpecs } from "./commands/operations.js";
import { projectCommandSpecs } from "./commands/project.js";
import { repoCommandSpecs } from "./commands/repo.js";
import { tokenCommandSpecs } from "./commands/token.js";
import { workspaceCommandSpecs } from "./commands/workspace.js";

const commandRegistry = new CommandRegistry();
commandRegistry.register(contextCommandSpec());
for (const spec of [
  ...workspaceCommandSpecs(),
  ...memberCommandSpecs(),
  ...inviteCommandSpecs(),
  ...tokenCommandSpecs(),
  ...projectCommandSpecs(),
  ...repoCommandSpecs(),
  ...knowledgeCommandSpecs(),
  ...collaborationCommandSpecs(),
  ...agentExtensionCommandSpecs(),
  ...operationsCommandSpecs(),
]) commandRegistry.register(spec);

// Lazy-load commands to avoid importing heavy modules when not needed
function register(
  name: string,
  description: string,
  loader: () => Promise<{ run: (args: string[]) => Promise<void> }>,
  hidden?: boolean,
  source: CommandSource = { kind: "builtin" },
): void {
  commandRegistry.register({
    id: source.kind === "plugin" ? `plugin-cli.${normalizeCommandId(source.pluginId)}.${normalizeCommandId(name)}` : `legacy.${name}`,
    path: [name],
    description,
    hidden,
    source,
    parse: "passthrough",
    run: async (invocation) => {
      const mod = await loader();
      await mod.run([...invocation.rawArgs]);
    },
  });
}

// Forward a `remi <name> …` command into the multiremi command layer (worker /
// setup / issue / repo all live there). programName "remi multiremi" so the
// agent's background re-invoke reconstructs a valid command on this binary.
function forward(name: string, description: string, prefix: string[], hidden?: boolean): void {
  register(name, description, async () => ({
    run: async (args: string[]) => {
      const { runMultiremi } = await import("./multiremi.js");
      await runMultiremi([...prefix, ...args], { programName: "remi multiremi" });
    },
  }), hidden);
}

// ── Agent lifecycle (multiremi worker + Feishu channels) ──
forward("start", "Start the agent (multiremi worker + Feishu channel, per config)", ["daemon", "start"]);
forward("stop", "Stop the agent", ["daemon", "stop"]);
forward("restart", "Restart the agent", ["daemon", "restart"]);
forward("status", "Show agent status", ["daemon", "status"]);
forward("logs", "Show agent logs (-f to follow)", ["daemon", "logs"]);
forward("service", "Install/uninstall the agent as an OS service", ["daemon", "service"]);

// ── Configuration ──
forward("setup", "Configure the multiremi server connection", ["setup"]);
forward("config", "Get/set agent config keys", ["config"]);

// ── multiremi server task/issue management (client → server) ──
forward("issue", "Manage issues on the multiremi server", ["issue"]);
forward("attachment", "Download an attachment", ["attachment"]);

// ── Monolith-native ──
register("doctor", "Health check (runtime, config, auth)", async () => {
  const { runDoctor } = await import("./doctor.js");
  return { run: runDoctor };
});

register("login", "Interactive setup wizard", async () => {
  const { runLogin } = await import("./login.js");
  return { run: runLogin };
});

register("update", "Download latest version from GitHub", async () => {
  const { runUpdate } = await import("./update.js");
  return { run: runUpdate };
});

// ── Internal / hidden ──
// Feishu production subprocess (legacy PM2 entry; the Feishu channel now also
// comes up via `remi start`).
register("serve", "Production daemon (PM2 subprocess)", async () => {
  const { runServe } = await import("./serve.js");
  return { run: runServe };
}, true);

register("git-credential", "Multiremi JIT Git credential helper", async () => {
  return await import("./git-credential.js");
}, true);

// `remi multiremi …` retained (hidden): the agent background re-invoke targets
// `remi multiremi daemon start --foreground`.
register("multiremi", "Multiremi subcommands (internal)", async () => {
  const { runMultiremi } = await import("./multiremi.js");
  return { run: runMultiremi };
}, true);

// ── Dispatcher ───────────────────────────────────────────

function showHelp(): void {
  console.log(`\nRemi v${VERSION} — Personal AI Assistant\n`);
  console.log("Usage: remi <command> [options]\n");
  console.log("Commands:");
  for (const cmd of commandRegistry.topLevelCommands()) {
    if (cmd.hidden) continue;
    const source = cmd.source.kind === "plugin" ? ` [plugin:${cmd.source.pluginId}]` : "";
    console.log(`  ${cmd.path[0]!.padEnd(12)} ${cmd.description}${source}`);
  }
  for (const entry of commandRegistry.inventory()) {
    for (const alias of entry.aliases.filter((candidate) => !candidate.hidden && candidate.path.length === 1)) {
      const replacement = alias.replacement ?? `remi ${entry.path.join(" ")}`;
      console.log(`  ${alias.path[0]!.padEnd(12)} Deprecated alias; use ${replacement}`);
    }
  }
  console.log("");
}

/** Register CLI subcommands contributed by plugins (in-tree + external). Best-effort. */
function loadPluginCommands(): void {
  try {
    const { loadConfig } = require("@shared/config.js");
    const { PluginRegistry } = require("@daemon/agent-runtime/plugins/registry.js");
    // Guard: a plugin must not shadow a built-in command.
    new PluginRegistry().load(loadConfig()).dispatchCli(registerPluginCliCommand);
  } catch (e) {
    // never block the dispatcher on plugin load issues — but say so, otherwise a
    // broken require path silently disables every plugin command forever.
    console.error(`[plugins] CLI command loading failed: ${e instanceof Error ? e.message : e}`);
  }
}

const builtinTopLevelCommands = new Set(commandRegistry.topLevelCommands().map((entry) => entry.path[0]!));

export function registerPluginCliCommand(
  name: string,
  description: string,
  loader: () => Promise<{ run: (args: string[]) => Promise<void> }>,
  hidden = false,
  source?: { kind: "plugin"; pluginId: string; pluginVersion: string },
): boolean {
  if (builtinTopLevelCommands.has(name)) {
    console.error(`[plugins] command "${name}" conflicts with a built-in command, ignored`);
    return false;
  }
  if (commandRegistry.hasPath([name])) return false;
  if (!source) {
    console.error(`[plugins] command "${name}" has no plugin source, ignored`);
    return false;
  }
  register(name, description, loader, hidden, source);
  return true;
}

function normalizeCommandId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-") || "unknown";
}

export async function dispatch(args: string[]): Promise<void> {
  const cmd = args[0] ?? "help";
  const cmdArgs = args.slice(1);

  if (cmd === "--version" || cmd === "-V") {
    console.log(VERSION);
    return;
  }

  // Only load plugin CLI commands when needed: for help (discoverability) or an
  // unknown command (might be plugin-provided). Skip the scan for known built-in
  // commands so `remi serve`/`status`/etc. don't run external plugin code.
  const isHelp = cmd === "--help" || cmd === "-h" || cmd === "help";
  if (isHelp || !commandRegistry.hasPath([cmd])) loadPluginCommands();

  if (isHelp) {
    if (cmd === "help" && cmdArgs.length) console.log(commandRegistry.renderHelpForArgv(cmdArgs));
    else showHelp();
    return;
  }

  const helpIndex = args.findIndex((arg) => arg === "--help" || arg === "-h");
  if (helpIndex >= 0 && commandRegistry.supportsGeneratedHelp(args.slice(0, helpIndex))) {
    console.log(commandRegistry.renderHelpForArgv(args.slice(0, helpIndex)));
    return;
  }

  if (!commandRegistry.resolve(args)) {
    console.error(`Unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
  }

  await commandRegistry.execute([cmd, ...cmdArgs], {
    onDeprecatedAlias: (alias) => {
      const replacement = alias.replacement ? `; use ${alias.replacement}` : "";
      console.error(`Deprecated command alias: remi ${alias.path.join(" ")}${replacement}`);
    },
  });
}

export function cliCommandInventory(): readonly CommandInventoryEntry[] {
  return commandRegistry.inventory();
}

export function cliCommandHelp(path: readonly string[]): string {
  return commandRegistry.renderHelp(path);
}
