import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const before = resolve(repo, "../.worktrees/r4-before");
const env = { ...process.env, MUL472_R4_MAIN: "b95dd2fa5e301588ba1e04aa9bacc370240d664c", MUL472_R4_FIXTURE_AUTH: randomBytes(24).toString("hex") };
delete env.MULTIREMI_TOKEN;
const services: ReturnType<typeof Bun.spawn>[] = [];
function start(command: string[], cwd: string, extra: Record<string, string> = {}) {
  const service = Bun.spawn(command, { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const mask = (value: string) => value.replaceAll(env.MUL472_R4_FIXTURE_AUTH, "[fixture auth]").replace(/(?:postgres(?:ql)?|redis):\/\/\S+/g, "[connection]");
  void new Response(service.stdout).text().then(log => { if (service.exitCode) console.error(mask(log)); });
  void new Response(service.stderr).text().then(log => { if (service.exitCode) console.error(mask(log)); });
  services.push(service);
}
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 180; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* Initial dev compile. */ }
    await Bun.sleep(500);
  }
  throw new Error(`Fixture did not become ready: ${new URL(url).pathname}`);
}
process.on("SIGINT", () => { for (const service of services) service.kill("SIGINT"); });
try {
  start([process.execPath, resolve(import.meta.dir, "fixture.ts")], repo);
  await waitFor("http://127.0.0.1:16860/health");
  for (const [cwd, port] of [[before, "3560"], [repo, "3561"]]) start(["node", resolve(cwd, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--port", port], resolve(cwd, "frontend/apps/web"), { REMOTE_API_URL: "http://127.0.0.1:16860" });
  await waitFor("http://localhost:3560/login"); await waitFor("http://localhost:3561/login");
  const phases = process.argv[2] === "after" ? ["after"] : ["before", "after"];
  for (const phase of phases) for (const mode of ["six", "path", "long", "open"]) {
    if (!(await fetch("http://127.0.0.1:16861/reset-inbox", { method: "POST" })).ok) throw new Error("reset failed");
    const probe = Bun.spawn([process.execPath, resolve(import.meta.dir, "probe.ts"), phase, mode], { cwd: repo, env, stdout: "inherit", stderr: "inherit" });
    if (await probe.exited !== 0) throw new Error(`Probe failed: ${phase}/${mode}`);
  }
} finally {
  for (const service of services) service.kill("SIGINT");
  await Promise.all(services.map(async service => {
    if (!await Promise.race([service.exited.then(() => true), Bun.sleep(5000).then(() => false)])) service.kill("SIGTERM");
    await service.exited;
  }));
}
