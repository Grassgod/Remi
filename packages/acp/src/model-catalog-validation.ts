import { stringify } from "smol-toml";
import { resolveAcpExecutableForAgent } from "./provider.js";

/** Validate with the same Codex decoder the ACP bridge will launch, without a model request. */
export async function validateCodexModelCatalog(catalogPath: string, home: string, signal: AbortSignal): Promise<void> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const stop = () => {
    if (!child) return;
    if (process.platform === "win32") {
      try { Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch {}
    } else {
      try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
    }
    try { child.kill("SIGKILL"); } catch {}
  };
  try {
    signal.throwIfAborted();
    const executable = resolveAcpExecutableForAgent("codex", undefined, "codex-acp");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    // The bridge's cli command honors CODEX_PATH and otherwise uses its bundled Codex.
    child = Bun.spawn([executable, "cli", "debug", "models", "-c", stringify({ model_catalog_json: catalogPath }).trim()], {
      cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      detached: process.platform !== "win32",
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    timer = setTimeout(() => { timedOut = true; stop(); }, 10_000);
    const code = await child.exited;
    if (code !== 0 || signal.aborted || timedOut) throw new Error();
  } catch {
    stop();
    if (child) await child.exited.catch(() => {});
    throw new Error("Runtime codex model catalog validation failed");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
