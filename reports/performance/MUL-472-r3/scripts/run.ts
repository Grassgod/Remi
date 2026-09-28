import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const before = resolve(repo, "../.worktrees/r3-before");
const reworkBefore = resolve(repo, "../.worktrees/r3-rework-before");
const env = { ...process.env, MUL472_R3_MAIN: "36fb03c47eba7914be7a4d026f19e360b83a0f83", MUL472_R3_FIXTURE_AUTH: randomBytes(24).toString("hex") };
delete env.MULTIREMI_TOKEN;
const services: ReturnType<typeof Bun.spawn>[] = [];

function start(command: string[], cwd: string, extra: Record<string, string> = {}) {
  const service = Bun.spawn(command, { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  // Consume service logs in memory. Fixture authentication never leaves memory.
  const mask = (value: string) => value.replaceAll(env.MUL472_R3_FIXTURE_AUTH, "[fixture auth]")
    .replace(/(?:postgres(?:ql)?|redis):\/\/\S+/g, "[connection]");
  void new Response(service.stdout).text().then((log) => { if (service.exitCode) console.error(mask(log)); });
  void new Response(service.stderr).text().then((log) => { if (service.exitCode) console.error(mask(log)); });
  services.push(service);
  return service;
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch { /* Next can take several seconds to compile the first route. */ }
    await Bun.sleep(500);
  }
  throw new Error(`Local fixture did not become ready: ${new URL(url).pathname}`);
}

process.on("SIGINT", () => { for (const service of services) service.kill("SIGINT"); });

async function probe(phase: string, mode: string): Promise<void> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "probe.ts"), phase, mode], {
    cwd: repo, env, stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error(`Probe failed: ${phase}/${mode}`);
}

try {
  start([process.execPath, resolve(import.meta.dir, "fixture.ts")], repo);
  await waitFor("http://127.0.0.1:16860/health");
  for (const [cwd, port] of [[before, "3560"], [repo, "3561"], [reworkBefore, "3562"]]) {
    start(["node", resolve(cwd, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--port", port],
      resolve(cwd, "frontend/apps/web"), { REMOTE_API_URL: "http://127.0.0.1:16860" });
  }
  await waitFor("http://localhost:3560/login");
  await waitFor("http://localhost:3561/login");
  await waitFor("http://localhost:3562/login");
  console.log("MUL-472 R3 local services ready; starting recorder rounds");
  const runs: [string, string[]][] = process.argv[2] === "return"
    ? [["rework-before", ["return"]], ["after", ["return"]]]
    : process.argv[2] === "after" ? [["after", ["six", "return", "path"]]]
      : [["before", ["six", "path"]], ["rework-before", ["return"]], ["after", ["six", "return", "path"]]];
  for (const [phase, modes] of runs) {
    const reset = await fetch("http://127.0.0.1:16861/reset-inbox", { method: "POST" });
    if (!reset.ok) throw new Error("fixture inbox reset failed");
    for (const mode of modes) await probe(phase, mode);
  }
} finally {
  for (const service of services) service.kill("SIGINT");
  await Promise.all(services.map(async (service) => {
    const stopped = await Promise.race([service.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!stopped) service.kill("SIGTERM");
    await service.exited;
  }));
}
