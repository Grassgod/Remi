import { networkInterfaces } from "node:os";
import { MulticaDaemon, startMulticaServer, MulticaStore } from "../multica/index.js";
import { setLogLevel } from "../logger.js";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
}

export async function runMultica(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  setLogLevel(String(parsed.options.logLevel ?? parsed.options["log-level"] ?? process.env.REMI_LOG_LEVEL ?? "INFO"));

  switch (parsed.command) {
    case "serve":
      await serve(parsed.options);
      return;
    case "daemon":
      await daemon(parsed.options);
      return;
    case "seed":
      seed(parsed.options);
      return;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      return;
    default:
      console.error(`Unknown multica command: ${parsed.command}`);
      showHelp();
      process.exit(1);
  }
}

async function serve(options: Record<string, string | boolean>): Promise<void> {
  const port = numberOpt(options.port, process.env.MULTICA_PORT, 6130);
  const host = stringOpt(options.host, process.env.MULTICA_HOST) ?? "0.0.0.0";
  const token = stringOpt(options.token, process.env.MULTICA_TOKEN);
  const server = startMulticaServer({ port, hostname: host, authToken: token });
  console.log(`Bun Multica API listening on ${formatListenUrls(host, server.port ?? port).join(", ")}`);
  await waitForShutdown(() => server.stop(true));
}

async function daemon(options: Record<string, string | boolean>): Promise<void> {
  const serverUrl = stringOpt(options.server, process.env.MULTICA_SERVER_URL) ?? "http://127.0.0.1:6130";
  const daemon = new MulticaDaemon({
    serverUrl,
    token: stringOpt(options.token, process.env.MULTICA_TOKEN),
    runtimeId: stringOpt(options.runtimeId ?? options["runtime-id"], process.env.MULTICA_RUNTIME_ID),
    runtimeName: stringOpt(options.name, process.env.MULTICA_RUNTIME_NAME) ?? undefined,
    provider: stringOpt(options.provider, process.env.MULTICA_PROVIDER) ?? "claude",
    workspaceId: stringOpt(options.workspace, process.env.MULTICA_WORKSPACE_ID) ?? "local",
    once: Boolean(options.once),
  });
  process.on("SIGINT", () => daemon.stop());
  process.on("SIGTERM", () => daemon.stop());
  await daemon.start();
}

function seed(options: Record<string, string | boolean>): void {
  const provider = stringOpt(options.provider, process.env.MULTICA_PROVIDER) ?? "claude";
  const store = new MulticaStore();
  const agent = store.ensureDefaultAgent(provider);
  console.log(`Default ${provider} agent: ${agent.id}`);
}

function showHelp(): void {
  console.log(`
Usage: remi multica <command> [options]

Commands:
  serve                  Start Bun Multica API server
  daemon                 Start local Bun Multica runtime daemon
  seed                   Create a default local agent

Options:
  --port <number>        API port for serve (default: 6130)
  --host <address>       API listen host for serve (default: 0.0.0.0)
  --token <token>        Bearer token for server/daemon auth
  --server <url>         Daemon server URL (default: http://127.0.0.1:6130)
  --provider <name>      Agent provider/runtime provider: claude or codex
  --workspace <id>       Workspace id (default: local)
  --runtime-id <id>      Reuse a fixed runtime id
  --name <name>          Runtime display name
  --once                 Daemon exits after one poll/claimed task
`);
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "help";
  const options: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i++;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function stringOpt(value: unknown, fallback?: string): string | null {
  const raw = typeof value === "string" ? value : fallback;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function numberOpt(value: unknown, fallback: string | undefined, defaultValue: number): number {
  const raw = typeof value === "string" ? value : fallback;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function formatListenUrls(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
  const urls = [`http://127.0.0.1:${port}`];
  for (const address of localIPv4Addresses()) {
    urls.push(`http://${address}:${port}`);
  }
  return [...new Set(urls)];
}

function localIPv4Addresses(): string[] {
  const result: string[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

async function waitForShutdown(stop: () => void): Promise<void> {
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const shutdown = () => {
    stop();
    resolve();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await done;
}

export const run = runMultica;
