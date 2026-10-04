import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HERMETIC_ENV_RUN_ROOT_PATHS, scrubInheritedEnv } from "../setup/hermetic-env-policy.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CHILD_ENTRY = join(import.meta.dir, "two-process-child.ts");
const DEADLINE_MS = 15_000;

export async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs = DEADLINE_MS): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await check()) return true;
    await Bun.sleep(Math.min(20, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  return false;
}

/** Never include inherited credentials, connection strings, or auth frames in evidence. */
export function redactDiagnostic(value: string): string {
  let safe = value.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"']+/gi, "[redacted URL]");
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && /TOKEN|SECRET|PASSWORD|POSTGRES_URL|DATABASE_URL|API_KEY/.test(key)) {
      safe = safe.replaceAll(secret, "[redacted]");
    }
  }
  return safe;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No system-assigned port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface IpcMessage {
  event?: "prepared" | "ready" | "error";
  id?: number;
  value?: unknown;
  error?: string;
}

export class ApiChild {
  readonly process: Bun.Subprocess;
  readonly events = new Set<string>();
  private readonly replies = new Map<number, IpcMessage>();
  private sequence = 0;
  private failure: string | null = null;
  private diagnostics = "";

  constructor(readonly port: number, env: Record<string, string | undefined>) {
    this.process = Bun.spawn([process.execPath, "--no-env-file", CHILD_ENTRY], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      ipc: (message: IpcMessage) => {
        if (message.event) this.events.add(message.event);
        if (message.event === "error") this.failure = message.error ?? "Child failed";
        if (message.id !== undefined) this.replies.set(message.id, message);
      },
    });
    // Drain while running: waiting until exit can deadlock a full stderr pipe.
    for (const stream of [this.process.stdout, this.process.stderr]) {
      void (async () => {
        for await (const chunk of stream as ReadableStream<Uint8Array>) {
          this.diagnostics = (this.diagnostics + redactDiagnostic(new TextDecoder().decode(chunk))).slice(-3000);
        }
      })();
    }
  }

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  private checkAlive(): void {
    if (this.failure || this.process.exitCode !== null) {
      throw new Error(`Child ${this.process.pid}: ${this.failure ?? `exit ${this.process.exitCode}`}\n${this.diagnostics}`);
    }
  }

  async waitEvent(event: string): Promise<void> {
    const reached = await pollUntil(() => {
      this.checkAlive();
      return this.events.has(event);
    });
    if (!reached) throw new Error(`Child ${this.process.pid} did not report ${event} by deadline\n${this.diagnostics}`);
  }

  start(): void { this.process.send({ command: "start" }); }

  async ready(): Promise<void> {
    await this.waitEvent("ready");
    const reached = await pollUntil(async () => {
      this.checkAlive();
      try {
        const response = await fetch(`${this.url}/readyz`, { signal: AbortSignal.timeout(1000) });
        return response.status === 200;
      } catch { return false; }
    });
    if (!reached) throw new Error("API /readyz deadline exceeded");
  }

  async call<T>(command: string, args: unknown = {}): Promise<T> {
    this.checkAlive();
    const id = ++this.sequence;
    this.process.send({ id, command, args });
    const reached = await pollUntil(() => {
      this.checkAlive();
      return this.replies.has(id);
    });
    if (!reached) throw new Error(`Child command ${command} deadline exceeded`);
    const reply = this.replies.get(id)!;
    this.replies.delete(id);
    if (reply.error) throw new Error(redactDiagnostic(reply.error));
    return reply.value as T;
  }

  async stop(): Promise<void> {
    if (this.process.exitCode === null) this.process.kill("SIGTERM");
    if (!await pollUntil(() => this.process.exitCode !== null, 3000)) this.process.kill("SIGKILL");
    await this.process.exited;
  }
}

export interface FreshDatabase { name: string; url: string }
export type ProcessPair = [ApiChild, ApiChild];

/** Database and spawn helpers copied from MUL-405's manual harness; that file stays untouched. */
export class TwoProcessResources {
  private readonly databases = new Set<string>();
  private readonly children = new Set<ApiChild>();
  private readonly directory = mkdtempSync(join(tmpdir(), "mul463-two-process-"));
  readonly authToken = randomUUID();
  private readonly peerSecret = randomUUID();
  private readonly childEnv: Record<string, string | undefined>;

  constructor() {
    this.childEnv = { ...process.env };
    scrubInheritedEnv(this.childEnv);
    for (const name of Object.keys(HERMETIC_ENV_RUN_ROOT_PATHS)) {
      this.childEnv[name] = process.env[name];
    }
    this.childEnv.MULTIREMI_TEST_LOCK_ORDER_SENTINEL = process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL ?? "1";
  }

  private async admin<T>(fn: (sql: InstanceType<typeof Bun.SQL>) => Promise<T>): Promise<T> {
    const url = process.env.MULTIREMI_TEST_POSTGRES_URL;
    if (!url) throw new Error("MULTIREMI_TEST_POSTGRES_URL is not set");
    const sql = new Bun.SQL(url, { max: 1 });
    try { return await fn(sql); }
    finally { await sql.end(); }
  }

  async freshDatabase(): Promise<FreshDatabase> {
    const name = `mul463_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
    url.pathname = `/${name}`;
    this.databases.add(name);
    await this.admin(async (sql) => { await sql.unsafe(`CREATE DATABASE ${name}`); });
    return { name, url: url.toString() };
  }

  async dropDatabase(name: string): Promise<void> {
    if (!this.databases.has(name) || !/^mul463_[a-f0-9]{32}$/.test(name)) {
      throw new Error("Refusing to drop a database not owned by this test");
    }
    await this.admin(async (sql) => { await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); });
    this.databases.delete(name);
  }

  private spawn(databaseUrl: string, port: number, peerPort: number, role: "ui" | "runtime"): ApiChild {
    const child = new ApiChild(port, {
      ...this.childEnv,
      NODE_ENV: "test",
      MULTIREMI_DATABASE_URL: databaseUrl,
      MULTIREMI_API_ROLE: role,
      MULTIREMI_PORT: String(port),
      MULTIREMI_HOST: "127.0.0.1",
      MULTIREMI_PEER_URL: `http://127.0.0.1:${peerPort}`,
      MULTIREMI_PEER_SECRET: this.peerSecret,
      MULTIREMI_TOKEN: this.authToken,
      MULTIREMI_BACKGROUND_JOBS: "0",
      MULTIREMI_SESSION_ARCHIVE_ROOT: join(this.directory, String(port)),
    });
    this.children.add(child);
    return child;
  }

  /** Both children connect/import before one IPC release starts both migrations. */
  async spawnPair(databaseUrl: string, start = true): Promise<ProcessPair> {
    const ports = await Promise.all([freePort(), freePort()]);
    if (ports[0] === ports[1]) return this.spawnPair(databaseUrl, start);
    const pair: ProcessPair = [
      this.spawn(databaseUrl, ports[0]!, ports[1]!, "ui"),
      this.spawn(databaseUrl, ports[1]!, ports[0]!, "runtime"),
    ];
    await Promise.all(pair.map((child) => child.waitEvent("prepared")));
    if (start) {
      pair.forEach((child) => child.start());
      await Promise.all(pair.map((child) => child.ready()));
    }
    return pair;
  }

  async restartRuntime(pair: ProcessPair, databaseUrl: string): Promise<void> {
    await pair[1].stop();
    pair[1] = this.spawn(databaseUrl, pair[1].port, pair[0].port, "runtime");
    await pair[1].waitEvent("prepared");
    pair[1].start();
    await pair[1].ready();
  }

  async stopPair(pair: ProcessPair): Promise<void> {
    await Promise.all(pair.map((child) => child.stop()));
  }

  async cleanup(): Promise<void> {
    const stopped = await Promise.allSettled([...this.children].map((child) => child.stop()));
    const dropped = await Promise.allSettled([...this.databases].map((name) => this.dropDatabase(name)));
    rmSync(this.directory, { recursive: true, force: true });
    if ([...stopped, ...dropped].some((result) => result.status === "rejected")) {
      throw new Error("Two-process cleanup failed");
    }
  }
}
