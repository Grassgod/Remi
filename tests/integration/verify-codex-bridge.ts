#!/usr/bin/env bun
/** Opt-in check of a real npm installation; --prompt also calls the model. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AcpClient } from "@acp/client.js";
import { BRIDGE_PIN, CODEX_USAGE_PATCH, patchCodexUsageBridge } from "@acp/provision.js";

const args = process.argv.slice(2);
const packageArg = args.find((arg) => arg.startsWith("--package-dir="))?.slice("--package-dir=".length);
assert(packageArg, "Pass --package-dir=<isolated npm prefix>/node_modules/@agentclientprotocol/codex-acp");
const packageDir = resolve(packageArg);
const entry = join(packageDir, "dist", "index.js");
const bridge = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
assert.equal(bridge.name, "@agentclientprotocol/codex-acp");
assert.equal(bridge.version, BRIDGE_PIN.codex);
// This check intentionally fails at the next dependency change: inspect and
// validate the new pair before updating the release's compatibility baseline.
assert.equal(bridge.dependencies["@openai/codex"], "^0.153.4");
const codexEntry = createRequire(entry).resolve("@openai/codex/bin/codex.js");
const codex = JSON.parse(readFileSync(join(dirname(dirname(codexEntry)), "package.json"), "utf8"));
assert.equal(codex.version, "0.153.4");
const node = Bun.which("node");
assert(node, "Node is required to launch the published bridge and its bundled CLI");
const cliVersion = execFileSync(node, [codexEntry, "--version"], { encoding: "utf8", timeout: 15_000 }).trim();
assert.equal(cliVersion, `codex-cli ${codex.version}`);
assert(patchCodexUsageBridge(undefined, packageDir), "Published usage patch anchor must match");
const patched = readFileSync(entry, "utf8");
assert(patchCodexUsageBridge(undefined, packageDir));
assert.equal(readFileSync(entry, "utf8"), patched, "Patching must be idempotent");

// Run the actual published conversion + event methods, including the patch.
// This detects token-field/semantic changes that a marker-only check misses.
const tokenCount = patched.match(/function toTokenCount\(usage\) \{[\s\S]*?\n\}/)?.[0];
const usageMethods = patched.match(/  handleTokenUsageUpdated\(params\) \{[\s\S]*?(?=  handleRateLimitsUpdated\()/)?.[0];
assert(tokenCount && usageMethods, "Inspect the new bridge's usage conversion layout");
const handler = new Function(`${tokenCount}\nreturn { sessionState: {}, ${usageMethods.replace(/\n  }\n/g, "\n  },\n")} };`)();
const rawUsage = { totalTokens: 130, inputTokens: 100, cachedInputTokens: 60, outputTokens: 30, reasoningOutputTokens: 10 };
const update = handler.createUsageUpdate({ tokenUsage: { last: rawUsage, total: rawUsage, modelContextWindow: 200_000 } });
assert.deepEqual(update, {
  sessionUpdate: "usage_update", used: 130, size: 200_000,
  _meta: {
    remiUsagePatch: CODEX_USAGE_PATCH,
    remiTokenUsage: { ...rawUsage, inputTokens: 40 },
  },
});
assert.equal(handler.createUsageUpdate({ tokenUsage: { last: rawUsage, total: rawUsage, modelContextWindow: null } }), null);

// Keep sessions/config out of the user's Codex home; reuse only an auth copy.
const temp = mkdtempSync(join(tmpdir(), "remi-codex-bridge-"));
const isolatedHome = join(temp, "codex-home");
const cwd = join(temp, "workspace");
mkdirSync(isolatedHome);
mkdirSync(cwd);
const auth = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
if (existsSync(auth)) copyFileSync(auth, join(isolatedHome, "auth.json"));
// This standalone harness tests the bundled CLI and native provider. Empty
// MODEL_PROVIDER is a real (invalid) provider ID upstream, so omit overrides.
for (const key of ["CODEX_PATH", "CODEX_CONFIG", "DEFAULT_AUTH_REQUEST", "MODEL_PROVIDER", "APP_SERVER_LOGS"]) {
  delete process.env[key];
}
let text = "";
let usageUpdates = 0;
let invalidUsageUpdates = 0;
const client = new AcpClient({
  executable: node, args: [entry], agentType: "codex", cwd,
  env: { CODEX_HOME: isolatedHome },
  log: (...messages) => { if (messages[0] === "stderr:") console.error(...messages); },
  onSessionUpdate: ({ update }) => {
    if (update.sessionUpdate === "agent_message_chunk") {
      for (const block of Array.isArray(update.content) ? update.content : [update.content]) {
        if (block.type === "text") text += block.text;
      }
    }
    if (update.sessionUpdate === "usage_update") {
      if (update._meta?.remiUsagePatch !== CODEX_USAGE_PATCH || !update._meta?.remiTokenUsage) invalidUsageUpdates++;
      usageUpdates++;
    }
  },
});
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  void client.stop();
}, 120_000);
try {
  console.log("Checking ACP initialize...");
  await client.start();
  const initialized = await client.initialize();
  assert.equal(initialized.protocolVersion, 1);
  console.log("Checking ACP session/new...");
  const session = await client.newSession();
  assert(session.sessionId);
  const model = session.configOptions?.find((option) => option.category === "model");
  const effort = session.configOptions?.find((option) => option.category === "thought_level");
  assert(model && effort, "Bridge must advertise model and reasoning effort selectors");
  console.log(`Checking ACP model selection (${model.currentValue})...`);
  const selected = await client.setConfigOption(session.sessionId, model.id, model.currentValue);
  assert(selected.configOptions?.some((option) => option.id === model.id && option.currentValue === model.currentValue));
  console.log(`Checking ACP reasoning effort (${effort.currentValue})...`);
  await client.setConfigOption(session.sessionId, effort.id, effort.currentValue);
  assert(session.modes?.availableModes.some((mode) => mode.id === "read-only"));
  console.log("Checking ACP permission mode...");
  await client.setMode(session.sessionId, "read-only");
  if (args.includes("--prompt")) {
    console.log("Checking a real model reply and streamed usage...");
    const result = await client.prompt(session.sessionId, "Reply with exactly REMI_CODEX_BRIDGE_OK. Do not use tools.");
    assert.equal(result.stopReason, "end_turn");
    assert(text.includes("REMI_CODEX_BRIDGE_OK"));
    assert(usageUpdates > 0, "A real prompt must deliver patched usage updates");
    assert.equal(invalidUsageUpdates, 0, "All streamed usage must carry the Remi patch");
  }
  console.log("Checking ACP session/close...");
  await client.closeSession(session.sessionId);
  console.log(JSON.stringify({
    bridge: bridge.version, codex: codex.version, cliVersion,
    usagePatch: CODEX_USAGE_PATCH, protocolVersion: initialized.protocolVersion,
    model: model.currentValue, effort: effort.currentValue,
    modelCatalog: session.models?.availableModels.map((entry) => entry.modelId),
    prompt: args.includes("--prompt") ? "passed" : "not-run", usageUpdates,
    status: "passed",
  }, null, 2));
} catch (error) {
  if (timedOut) throw new Error("Codex bridge verification timed out after 120 seconds", { cause: error });
  throw error;
} finally {
  clearTimeout(timeout);
  await client.stop();
  // On Windows a native child may still be releasing SQLite handles. Cleanup
  // must not hide the protocol/prompt error; remove the auth copy separately.
  rmSync(join(isolatedHome, "auth.json"), { force: true });
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`Temporary session cleanup failed (${temp}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
