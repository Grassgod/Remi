import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const BUN_IMAGE = "oven/bun:1.3.14";
const READY_DELAY_MS = 150_000;
const OLD_STARTUP_WINDOW_MS = 120_000;
const templateFile = resolve(import.meta.dir, "../deploy/docker/compose.application.yml");
const runningCommands = new Set<Pick<Bun.Subprocess, "kill">>();
const projectCleanups = new Set<() => Promise<void>>();
let temporaryRoot: string | undefined;

interface ApplicationTemplate {
  services: {
    api: { healthcheck: Record<string, unknown> };
    web: { depends_on: Record<string, unknown> };
  };
}

export function createStartupCompose(template: ApplicationTemplate, withStartPeriod: boolean) {
  const healthcheck = structuredClone(template.services.api.healthcheck);
  assert(healthcheck?.test, "Application template must supply an API healthcheck");
  assert(healthcheck.start_period, "Application template must supply start_period");
  if (!withStartPeriod) delete healthcheck.start_period;
  const api = {
    image: BUN_IMAGE,
    command: ["bun", "-e", `await Bun.sleep(${READY_DELAY_MS}); Bun.serve({hostname:'0.0.0.0',port:6120,fetch:r=>new Response('ready',{status:new URL(r.url).pathname==='/readyz'?200:404})});`],
    healthcheck,
  };
  return { services: {
    api,
    "api-runtime": { ...structuredClone(api), profiles: ["split"] },
    web: {
      image: BUN_IMAGE,
      command: ["bun", "-e", "Bun.serve({hostname:'0.0.0.0',port:3000,fetch:()=>new Response('web ready')});"],
      depends_on: structuredClone(template.services.web.depends_on),
    },
  } };
}

async function docker(args: string[], timeoutMs = 60_000) {
  // This fixture owns temporary local projects, never an inherited Compose host.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(COMPOSE_|REMI_|MULTIREMI_|DOCKER_)/.test(key)) delete env[key];
  }
  const proc = Bun.spawn(["docker", "--context", "default", ...args], { env, stdout: "pipe", stderr: "pipe" });
  runningCommands.add(proc);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    assert(!timedOut, `docker ${args[0]} exceeded ${timeoutMs}ms`);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); runningCommands.delete(proc); }
}

async function reproduce(template: ApplicationTemplate, root: string, withStartPeriod: boolean) {
  const label = withStartPeriod ? "grace" : "control";
  const project = `mul528-${process.pid}-${Date.now().toString(36)}-${label}`;
  const file = join(root, `${label}.json`);
  await writeFile(file, JSON.stringify(createStartupCompose(template, withStartPeriod)));
  const composeArgs = ["compose", "--project-name", project, "--profile", "split", "-f", file];
  const compose = (args: string[], timeoutMs?: number) => docker([...composeArgs, ...args], timeoutMs);
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    const result = await compose(["down", "--volumes", "--remove-orphans", "--timeout", "1"], 60_000);
    assert.equal(result.exitCode, 0, `Failed to clean temporary project ${project}: ${result.stderr}`);
    projectCleanups.delete(cleanup);
  })();
  projectCleanups.add(cleanup);
  async function state(service: string) {
    const id = await compose(["ps", "--all", "-q", service]);
    assert.equal(id.exitCode, 0, id.stderr);
    assert(id.stdout.trim(), `${label}: ${service} container missing`);
    const inspected = await docker(["inspect", "--format", "{{json .State}}", id.stdout.trim()]);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    return JSON.parse(inspected.stdout) as { Running: boolean; Health?: { Status: string } };
  }
  try {
    const started = performance.now();
    const result = await compose(["up", "-d", "--no-deps", "api", "web", "api-runtime"], 420_000);
    const elapsedMs = Math.round(performance.now() - started);
    console.log(`${label}: up exit=${result.exitCode}, elapsed=${elapsedMs}ms\n${result.stdout}${result.stderr}`);
    if (withStartPeriod) {
      assert.equal(result.exitCode, 0, "Template healthcheck must survive startup beyond 120 seconds");
      assert(elapsedMs > OLD_STARTUP_WINDOW_MS, `up returned too early: ${elapsedMs}ms`);
      // `web` gates on api, so api-runtime may need its next probe after up returns.
      for (const service of ["api", "api-runtime"]) {
        const deadline = performance.now() + 30_000;
        let observed = await state(service);
        while (observed.Health?.Status === "starting" && performance.now() < deadline) {
          await Bun.sleep(1_000);
          observed = await state(service);
        }
        assert.equal(observed.Health?.Status, "healthy", `${label}: ${service} must be healthy`);
        console.log(`${label}: ${service} running=${observed.Running}, health=${observed.Health?.Status}`);
      }
      const web = await state("web");
      assert.equal(web.Running, true, "web must start after API readiness");
      console.log(`${label}: web running=${web.Running}`);
    } else {
      assert.notEqual(result.exitCode, 0, "Removing only start_period must reproduce the update failure");
      assert.match(`${result.stdout}${result.stderr}`, /is unhealthy/, "Control failure must match the 209 symptom");
      assert(elapsedMs >= 110_000 && elapsedMs < READY_DELAY_MS, `Control must fail around 120s, before readiness: ${elapsedMs}ms`);
      const api = await state("api"), runtime = await state("api-runtime"), web = await state("web");
      assert.equal(api.Health?.Status, "unhealthy", "Control API must actually be unhealthy");
      assert.equal(web.Running, false, "Control web must not cross the unhealthy API dependency");
      console.log(`${label}: api health=${api.Health?.Status}, api-runtime health=${runtime.Health?.Status}, web running=${web.Running}`);
    }
    console.log(`[pass] ${label}: ${withStartPeriod ? "both API roles healthy and web running" : "is unhealthy reproduced"}, ${elapsedMs}ms`);
  } catch (error) {
    const ps = await compose(["ps", "--all"]);
    const logs = await compose(["logs", "--no-color", "--tail", "20"]);
    console.error(`${ps.stdout}${ps.stderr}${logs.stdout}${logs.stderr}`);
    throw error;
  } finally {
    await cleanup();
  }
}

export async function checkComposeStartup(): Promise<void> {
  const template = parse(await readFile(templateFile, "utf8")) as ApplicationTemplate;
  const engine = await docker(["version", "--format", "Engine {{.Server.Version}}"]);
  assert.equal(engine.exitCode, 0, engine.stderr);
  console.log(engine.stdout.trim());
  const version = await docker(["compose", "version"]);
  assert.equal(version.exitCode, 0, version.stderr);
  console.log(version.stdout.trim());
  const pulled = await docker(["pull", BUN_IMAGE], 180_000);
  assert.equal(pulled.exitCode, 0, pulled.stderr);
  const root = await mkdtemp(join(tmpdir(), "mul528-compose-startup-"));
  temporaryRoot = root;
  try {
    await reproduce(template, root, true);
    await reproduce(template, root, false);
  } finally { await rm(root, { recursive: true, force: true }); temporaryRoot = undefined; }
}

if (import.meta.main) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const command of runningCommands) command.kill("SIGKILL");
      void (async () => {
        await Promise.allSettled([...projectCleanups].map(cleanup => cleanup()));
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
        process.exit(signal === "SIGINT" ? 130 : 143);
      })();
    });
  }
  await checkComposeStartup();
}
