import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const before = process.argv[2];
if (!before) throw new Error("Pass a dependency snapshot directory for the before web build");
const out = resolve(repo, "reports/performance/MUL-395-s9-3b");
const marker = randomBytes(24).toString("hex");
const env: Record<string, string | undefined> = { ...process.env, MUL395_S9_3B_FIXTURE_AUTH: marker, MULTIREMI_QA_WEB_TOKEN: marker,
  MUL395_S9_3B_BEFORE_HEAD: "e95b7a2345393fe7f79f13dcca3bdd4f6c32abe5" };
delete env.MULTIREMI_TOKEN;
const services: ReturnType<typeof Bun.spawn>[] = [];
const mask = (value: string) => value.replaceAll(marker, "[fixture auth]").replace(/(?:postgres(?:ql)?|redis):\/\/\S+/g, "[connection]");
function start(command: string[], cwd: string, extra: Record<string, string> = {}) {
  const service = Bun.spawn(command, { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  for (const stream of [service.stdout, service.stderr]) void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        process.stdout.write(`${mask(pending.slice(0, end))}\n`);
        pending = pending.slice(end + 1);
      }
    }
    if (pending) process.stdout.write(mask(pending));
  })();
  services.push(service);
  return service;
}
async function stop(service: ReturnType<typeof Bun.spawn>) {
  if (service.exitCode !== null) return;
  service.kill("SIGINT");
  if (!await Promise.race([service.exited.then(() => true), Bun.sleep(5000).then(() => false)])) service.kill("SIGTERM");
  await service.exited;
}
async function ready(url: string) {
  for (let n = 0; n < 180; n++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* First dev compile. */ }
    await Bun.sleep(500);
  }
  throw new Error(`Local service did not become ready: ${new URL(url).pathname}`);
}
async function probe(origin: string, name: string, only: string, rounds: number) {
  await fetch("http://127.0.0.1:18561/reset-inbox", { method: "POST" });
  const process = Bun.spawn([globalThis.process.execPath, "frontend/scripts/perf/page-speed.ts",
    "--base-url", origin, "--rounds", String(rounds), "--warmup", "--only", only,
    "--issue-short", "iss_detail", "--issue-long", "iss_mul454", "--issue-xlong", "iss_mul454",
    "--issue-running", "iss_pin_me", "--out", out, "--name", name], {
    cwd: repo, env, stdout: "pipe", stderr: "pipe",
  });
  services.push(process);
  await Promise.all([process.stdout, process.stderr].map(async (stream) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; globalThis.process.stdout.write(mask(decoder.decode(value))); }
  }));
  if (await process.exited !== 0) throw new Error(`S1 probe failed: ${name}`);
}
process.on("SIGINT", () => { for (const service of services) service.kill("SIGINT"); });
try {
  start([process.execPath, resolve(import.meta.dir, "mul395-s9-3b-fixture.ts")], repo);
  await ready("http://127.0.0.1:18560/health");
  for (const [phase, root, port] of [["before", resolve(before), "18570"], ["after", repo, "18571"]] as const) {
    const web = start(["node", resolve(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--port", port],
      resolve(root, "frontend/apps/web"), { REMOTE_API_URL: "http://127.0.0.1:18560" });
    const origin = `http://localhost:${port}`;
    await ready(`http://127.0.0.1:${port}/login`);
    for (const page of ["page-issues", "page-my-issues"]) await probe(origin, `${phase}-${page}`, page, 5);
    if (phase === "after") {
      for (const scene of ["page-issues", "page-inbox", "detail-short", "detail-xlong"]) await probe(origin, `after-472-${scene}`, scene, 1);
    }
    const positions = start([process.execPath, resolve(import.meta.dir, "mul395-s9-3b-positions.ts"), phase, origin], repo);
    if (await positions.exited !== 0) throw new Error(`S1 row-position probe failed: ${phase}`);
    await stop(web);
  }
} finally { await Promise.all(services.map(stop)); }
