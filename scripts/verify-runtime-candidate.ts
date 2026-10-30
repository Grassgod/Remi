import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AcpClient } from "../packages/acp/src/client.js";
import { ensureCursorAgent } from "../packages/acp/src/cursor-install.js";
import { ensureNode, patchCodexUsageBridge, patchClaudeUsageBridge } from "../packages/acp/src/provision.js";
import { installRuntimeBundle, runtimeBundleBridge, runtimeBundlePrefix } from "../packages/acp/src/runtime-bundle.js";
import { verifyAcpRuntime } from "../packages/acp/src/runtime-verify.js";
import { checkReleaseSnapshot, type RuntimeSnapshot } from "./release-runtime.js";

// Dedicated child process: all filesystem and environment changes stay in the
// release command's disposable REMI_HOME; no daemon or model Task is started.
if (import.meta.main) {
  const snapshot = JSON.parse(process.argv[2]!) as RuntimeSnapshot;
  checkReleaseSnapshot(snapshot.preparedFor!, snapshot);
  const log = (message: string) => console.error(`[release-runtime] ${message}`);
  const node = ensureNode(log);
  if (!node) throw new Error("Cannot verify release dependencies without Node/npm");
  process.env.PATH = `${dirname(node.node)}:${process.env.PATH ?? ""}`;
  for (const provider of ["claude", "codex"] as const) {
    const versions = snapshot[provider];
    log(`verifying ${provider}: ACP ${versions.acp}, SDK ${versions.sdk}, executable ${versions.executable}`);
    installRuntimeBundle(provider, node, (bridge) => {
      if (provider === "codex" && !patchCodexUsageBridge(log, bridge)) throw new Error("Codex usage patch verification failed");
      if (provider === "claude" && !patchClaudeUsageBridge(log, bridge)) throw new Error("Claude usage patch verification failed");
    }, versions);
    await verifyAcpRuntime(provider, runtimeBundleBridge(provider, runtimeBundlePrefix(provider, versions)));
  }
  log(`verifying Cursor CLI ${snapshot.cursor.version}`);
  const cursor = await ensureCursorAgent({ pin: snapshot.cursor, log });
  const version = spawnSync(cursor.executable, ["--version"], { env: process.env, encoding: "utf8", timeout: 15_000 });
  if (version.status !== 0 || version.stdout.trim() !== snapshot.cursor.version) {
    throw new Error(`Cursor CLI version check failed (expected ${snapshot.cursor.version})`);
  }
  const cwd = join(process.env.REMI_HOME!, "cursor-verify");
  mkdirSync(cwd, { recursive: true });
  const client = new AcpClient({
    agentType: "cursor", executable: cursor.executable, args: cursor.args, cwd, inheritProcessGroup: true, log: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const initialized = await Promise.race([
      (async () => { await client.start(); return client.initialize(); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cursor ACP initialization timed out")), 15_000); }),
    ]);
    if (initialized.protocolVersion !== 1 || initialized.agentCapabilities?.loadSession !== true) {
      throw new Error("Cursor ACP must support protocol version 1 and session loading");
    }
  } finally {
    clearTimeout(timer);
    await client.stop();
  }
}
