/**
 * Remi CLI — Command registry and dispatcher.
 *
 * Maps subcommand names to handler modules.
 * Each handler exports: async run(args: string[]): Promise<void>
 */

import { VERSION } from "../shared/version.js";

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

// ── User-facing commands ──────────────────────────────────

register("start", "Start all PM2 services", async () => {
  const { runStart } = await import("./pm2-commands.js");
  return { run: runStart };
});

register("stop", "Stop all PM2 services", async () => {
  const { runStop } = await import("./pm2-commands.js");
  return { run: runStop };
});

register("restart", "Restart all PM2 services", async () => {
  const { runRestart } = await import("./pm2-commands.js");
  return { run: runRestart };
});

register("status", "Show process status", async () => {
  const { runStatus } = await import("./pm2-commands.js");
  return { run: runStatus };
});

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

register("multiremi", "Bun Multiremi task runtime", async () => {
  const { runMultiremi } = await import("./multiremi.js");
  return { run: runMultiremi };
});

// ── Internal commands (used by PM2, not user-facing) ─────

register("serve", "Production daemon (PM2 subprocess)", async () => {
  const { runServe } = await import("./serve.js");
  return { run: runServe };
}, true);

register("auth", "Feishu OAuth (legacy)", async () => {
  const { runAuthCmd } = await import("./auth-cmd.js");
  return { run: runAuthCmd };
}, true);

// Legacy alias
register("pm2", "PM2 management (legacy)", async () => {
  const { runPm2Legacy } = await import("./pm2-legacy.js");
  return { run: runPm2Legacy };
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
    const { loadConfig } = require("../shared/config.js");
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
