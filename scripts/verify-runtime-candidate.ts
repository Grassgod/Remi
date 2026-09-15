import { dirname } from "node:path";
import { ensureNode, patchCodexUsageBridge } from "../packages/acp/src/provision.js";
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
    }, versions);
    await verifyAcpRuntime(provider, runtimeBundleBridge(provider, runtimeBundlePrefix(provider, versions)));
  }
}
