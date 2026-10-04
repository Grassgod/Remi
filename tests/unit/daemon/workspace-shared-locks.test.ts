import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Reply {
  ready?: boolean;
  pid?: number;
  acquired?: boolean;
  released?: boolean;
  stopped?: boolean;
  lockPath?: string;
  workDir?: string;
  waited?: boolean;
  pids?: number[];
  errorCode?: string;
}

async function bounded<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lock fixture timed out")), ms); }),
    ]);
  } finally { clearTimeout(timer!); }
}

async function startWorker(workspace: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../fixtures/workspace-shared-lock-process.ts"), workspace], {
    cwd: resolve(import.meta.dir, "../../.."), env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const queued: Reply[] = [];
  let deliver: ((reply: Reply) => void) | undefined;
  const reader = child.stdout.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        if (!line.startsWith("MUL512 ")) continue;
        const reply = JSON.parse(line.slice(7)) as Reply;
        if (deliver) { const resolveReply = deliver; deliver = undefined; resolveReply(reply); }
        else queued.push(reply);
      }
    }
  })();
  function next(): Promise<Reply> {
    const response = queued.length ? Promise.resolve(queued.shift()!) : new Promise<Reply>(resolveReply => { deliver = resolveReply; });
    return bounded(Promise.race([
      response,
      child.exited.then(async code => { throw new Error(`Lock fixture exited (${code}): ${await stderr}`); }),
    ]));
  }
  async function close(): Promise<void> {
    if (child.exitCode === null) {
      child.stdin.write(`${JSON.stringify({ op: "stop" })}\n`);
      child.stdin.end();
      try { await bounded(child.exited, 2_000); }
      catch { child.kill("SIGKILL"); await child.exited; }
    }
    await reading;
    await stderr;
  }
  try {
    const ready = await next();
    expect(ready.ready).toBe(true);
    return {
      pid: ready.pid!, close,
      async command(op: string): Promise<Reply> {
        child.stdin.write(`${JSON.stringify({ op })}\n`);
        await child.stdin.flush();
        return await next();
      },
    };
  } catch (error) { await close(); throw error; }
}

it.each(["production", "test"])("shares default workspace locks across STATE_DIRs in %s mode", async (mode) => {
  const base = mkdtempSync(join(tmpdir(), "multiremi-shared-locks-"));
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  mkdirSync(home); mkdirSync(workspace);
  const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
  try {
    for (const state of ["state-one", "state-two"]) {
      workers.push(await startWorker(workspace, {
        ...process.env, NODE_ENV: mode, HOME: home, USERPROFILE: home,
        MULTIREMI_STATE_DIR: join(base, state), MULTIREMI_TEST_RUN_ROOT: join(base, "run"),
        GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(base, "transpiler-cache"),
        BUN_INSTALL_CACHE_DIR: join(base, "install-cache"),
      }));
    }
    const [a, b] = workers;
    const first = await a!.command("supervisor-acquire");
    expect(first.acquired).toBe(true);
    const registry = mode === "production" ? join(home, ".multiremi") : join(base, "run", "shared-locks");
    expect(first.lockPath!.startsWith(join(registry, "workspace-supervisors"))).toBe(true);
    expect((await b!.command("owners")).pids).toEqual([a!.pid]);
    const denied = await b!.command("supervisor-acquire");
    expect(denied.acquired).toBe(false);
    expect(denied.errorCode).toBe("multiremi_workspace_supervisor_owned");
    expect((await a!.command("supervisor-release")).released).toBe(true);
    expect((await b!.command("owners")).pids).toEqual([]);
    const replacement = await b!.command("supervisor-acquire");
    expect(replacement.acquired).toBe(true);
    expect(replacement.lockPath).toBe(first.lockPath);
    await b!.command("supervisor-release");

    expect((await a!.command("runtime-acquire")).acquired).toBe(true);
    const waiting = await b!.command("runtime-contend");
    expect(waiting.acquired).toBe(false);
    expect(waiting.waited).toBe(true);
    expect(waiting.errorCode).toBe("ABORT_ERR");
    expect(readdirSync(join(registry, "runtime-workspace-leases")).length).toBeGreaterThan(0);
    expect((await a!.command("runtime-release")).released).toBe(true);
    const second = await b!.command("runtime-acquire");
    expect(second.acquired).toBe(true);
    expect(second.waited).toBe(false);
    expect(second.workDir).toBe(workspace);
    await b!.command("runtime-release");
    if (mode === "test") expect(readdirSync(home)).toEqual([]);
  } finally {
    try { for (const worker of workers) await worker.close(); }
    finally { rmSync(base, { recursive: true, force: true }); }
  }
}, 30_000);
