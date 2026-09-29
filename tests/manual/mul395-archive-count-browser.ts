import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const before = process.argv[2];
const lifecycle = process.argv.includes("--lifecycle");
const prefix = lifecycle ? "MUL-395-archive-marker" : "MUL-395-archive-count";
const marker = randomBytes(24).toString("hex");
const env: Record<string, string | undefined> = {
  ...process.env, MUL395_S9_3B_FIXTURE_AUTH: marker, MULTIREMI_QA_WEB_TOKEN: marker,
  MUL395_S9_3B_BEFORE_HEAD: before ? Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: before }).stdout.toString().trim() : "",
  REMOTE_API_URL: "http://127.0.0.1:18560", NEXT_TELEMETRY_DISABLED: "1",
};
delete env.MULTIREMI_TOKEN;
delete env.MULTIREMI_TEST_POSTGRES_URL;
const services: ReturnType<typeof Bun.spawn>[] = [];
const logs: string[] = [];
const drains: Promise<void>[] = [];
const mask = (value: string) => value.replaceAll(marker, "[fixture auth]")
  .replace(/(?:postgres(?:ql)?|redis):\/\/\S+/g, "[connection]");
function start(command: string[], cwd: string) {
  const service = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  services.push(service);
  for (const stream of [service.stdout, service.stderr]) drains.push((async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = mask(pending.slice(0, end));
        logs.push(line);
        if (logs.length > 40) logs.shift();
        if (line.startsWith('{"phase"')) console.log(line);
        pending = pending.slice(end + 1);
      }
    }
  })());
  return service;
}
async function stop(service: ReturnType<typeof Bun.spawn>) {
  if (service.exitCode !== null) return;
  service.kill("SIGINT");
  if (!await Promise.race([service.exited.then(() => true), Bun.sleep(5000).then(() => false)])) {
    service.kill("SIGTERM");
  }
  await service.exited;
}
async function ready(url: string) {
  for (let n = 0; n < 90; n++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(20000) })).ok) return;
    } catch { /* Allow the first local dev compile to finish. */ }
    await Bun.sleep(500);
  }
  throw new Error(`Local fixture failed to become ready: ${new URL(url).pathname}`);
}
process.on("SIGINT", () => { for (const service of services) if (service.exitCode === null) service.kill("SIGINT"); });
try {
  start([process.execPath, resolve(import.meta.dir, "mul395-s9-3b-fixture.ts")], repo);
  await ready("http://127.0.0.1:18560/health");
  const phases = [...(before ? [["before", resolve(before)]] : []), ["after", repo]];
  for (const [phase, root] of phases) {
    const web = start(["node", resolve(root!, "node_modules/next/dist/bin/next"), "dev", "--webpack",
      "--hostname", "127.0.0.1", "--port", "18572"], resolve(root!, "frontend/apps/web"));
    await ready("http://127.0.0.1:18572/login");
    await ready("http://127.0.0.1:18572/local/issues");
    await ready("http://127.0.0.1:18572/local/inbox");
    if (lifecycle) await ready("http://127.0.0.1:18572/local/my-issues");
    const output = resolve(repo, `reports/performance/${prefix}-${phase}.json`);
    const probe = start([process.execPath, resolve(import.meta.dir, "mul395-s9-3b-positions.ts"), phase!,
      "http://localhost:18572", lifecycle ? "--list-pages-only" : "--issues-only", "--rounds", "3", "--timeout", "20000", "--out",
      output], repo);
    if (await probe.exited !== 0) throw new Error(`Row-position recorder failed: ${phase}`);
    const sample = await Bun.file(output).json() as { results: {
      name: string; listRequests: number; archivedCountRequests: number;
    }[] };
    if (sample.results.length !== (lifecycle ? 18 : 6) || sample.results.some((row) =>
      row.listRequests !== (row.name === "my-issues-all" ? 3 : 1) || row.archivedCountRequests !== 0)) {
      throw new Error(`First-screen request count regression: ${phase}`);
    }
    await stop(web);
  }
} catch (error) {
  console.error(logs.join("\n"));
  throw error;
} finally {
  for (const service of services.toReversed()) await stop(service);
  await Promise.all(drains);
}
