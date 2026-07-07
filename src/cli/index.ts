/**
 * Remi CLI — Command registry and dispatcher.
 *
 * Maps subcommand names to handler modules.
 * Each handler exports: async run(args: string[]): Promise<void>
 */

import { VERSION } from "@shared/version.js";

interface Command {
  run: (args: string[]) => Promise<void>;
  description: string;
  hidden?: boolean;
}

const COMMANDS: Record<string, Command> = {};

// Lazy-load commands to avoid importing heavy modules when not needed
function register(name: string, description: string, loader: () => Promise<{ run: (args: string[]) => Promise<void> }>, hidden?: boolean): void {
  COMMANDS[name] = {
    description,
    hidden,
    run: async (args: string[]) => {
      const mod = await loader();
      await mod.run(args);
    },
  };
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
forward("repo", "Check out an allowed workspace repository", ["repo"]);
forward("issue", "Manage issues on the multiremi server", ["issue"]);
forward("attachment", "Download an attachment", ["attachment"]);
forward("seed", "Create a default local agent", ["seed"]);

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
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    if (cmd.hidden) continue;
    console.log(`  ${name.padEnd(12)} ${cmd.description}`);
  }
  console.log("");
}

/** Register CLI subcommands contributed by plugins (in-tree + external). Best-effort. */
function loadPluginCommands(): void {
  try {
    const { loadConfig } = require("@shared/config.js");
    const { PluginRegistry } = require("../daemon/agent-runtime/plugins/registry.js");
    const builtins = new Set(Object.keys(COMMANDS));
    // Guard: a plugin must not shadow a built-in command.
    const safeRegister: typeof register = (name, description, loader, hidden) => {
      if (builtins.has(name)) {
        console.error(`[plugins] command "${name}" conflicts with a built-in command, ignored`);
        return;
      }
      register(name, description, loader, hidden);
    };
    new PluginRegistry().load(loadConfig()).dispatchCli(safeRegister);
  } catch {
    // never block the dispatcher on plugin load issues
  }
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
  if (isHelp || !COMMANDS[cmd]) loadPluginCommands();

  if (isHelp) {
    showHelp();
    return;
  }

  const command = COMMANDS[cmd];
  if (!command) {
    console.error(`Unknown command: ${cmd}`);
    showHelp();
    process.exit(1);
  }

  await command.run(cmdArgs);
}
