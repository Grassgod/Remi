#!/usr/bin/env bun
/** Opt-in check of a real npm installation; --prompt also calls the model. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AcpClient } from "@acp/client.js";
import { BRIDGE_PIN, RUNTIME_PIN, CODEX_USAGE_PATCH, patchCodexUsageBridge } from "@acp/provision.js";
import { beginCodexRolloutUsage, collectCodexRolloutUsage } from "@acp/codex-rollout-usage.js";

const args = process.argv.slice(2);
const packageArg = args.find((arg) => arg.startsWith("--package-dir="))?.slice("--package-dir=".length);
assert(packageArg, "Pass --package-dir=<isolated npm prefix>/node_modules/@agentclientprotocol/codex-acp");
const packageDir = resolve(packageArg);
const entry = join(packageDir, "dist", "index.js");
const bridge = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
assert.equal(bridge.name, "@agentclientprotocol/codex-acp");
assert.equal(bridge.version, BRIDGE_PIN.codex);
// Remi's release bundle deliberately overrides the published SDK range. The
// executable actually resolved from this bridge must match the prepared pin.
assert.equal(typeof bridge.dependencies["@openai/codex"], "string");
const codexEntry = createRequire(entry).resolve("@openai/codex/bin/codex.js");
const codex = JSON.parse(readFileSync(join(dirname(dirname(codexEntry)), "package.json"), "utf8"));
assert.equal(codex.version, RUNTIME_PIN.codex.version);
const node = Bun.which("node");
assert(node, "Node is required to launch the published bridge and its bundled CLI");
const cliVersion = execFileSync(node, [codexEntry, "--version"], { encoding: "utf8", timeout: 15_000 }).trim();
assert.equal(cliVersion, `codex-cli ${RUNTIME_PIN.codex.executableVersion}`);
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
const rawUsage = { totalTokens: 130, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 };
const update = handler.createUsageUpdate({ tokenUsage: { last: rawUsage, total: rawUsage, modelContextWindow: 200_000 } });
assert.deepEqual(update, {
  sessionUpdate: "usage_update", used: 130, size: 200_000,
  _meta: {
    remiUsagePatch: CODEX_USAGE_PATCH,
    remiUsageMode: "request",
  },
});
assert.equal(handler.createUsageUpdate({ tokenUsage: { last: rawUsage, total: rawUsage, modelContextWindow: null } }).size, 0);
const eventStart = patched.indexOf("  async createUpdateEvent(notification) {");
const eventEnd = patched.indexOf("\n  createCodexSessionInfoUpdate(", eventStart);
assert(eventStart >= 0 && eventEnd > eventStart, "Inspect the new bridge's response notification layout");
const EventHandler = new Function(`return class { ${patched.slice(eventStart, eventEnd)} }`)();
const responseHandler = new EventHandler();
responseHandler.sessionState = { sessionId: "native-thread", currentModelId: "requested-model" };
const requestUpdate = await responseHandler.createUpdateEvent({ method: "rawResponse/completed", params: {
  threadId: "native-thread", turnId: "turn", responseId: "response", usage: { ...rawUsage, cacheWriteInputTokens: 20 },
} });
assert.deepEqual(requestUpdate._meta.remiTokenUsage, {
  id: "response", providerSessionId: "native-thread", providerRequestId: "response", turnId: "turn",
  scope: "request_snapshot", source: "codex_response_usage", accuracy: "exact", model: null,
  inputTokens: 20, cachedInputTokens: 60, cacheWriteTokens: 20, outputTokens: 30, totalTokens: 130,
  requestedModel: "requested-model", modelSource: "session_acknowledged",
});
// Execute the published child-subscription routing with transcript support off.
// Only discovered native children may publish usage to this parent envelope.
const discoverStart = patched.indexOf("  discover(session, event) {");
const discoverEnd = patched.indexOf("\n  registerInteractiveHandlers(", discoverStart);
assert(discoverStart >= 0 && discoverEnd > discoverStart, "Inspect native child subscription routing");
const Subscriptions = new Function(`return class { ${patched.slice(discoverStart, discoverEnd)} }`)();
const subscriptions = new Subscriptions();
const nativeHandlers = new Map<string, (event: any) => void>();
subscriptions.client = { onServerNotification: (thread: string, handler: (event: any) => void) => nativeHandlers.set(thread, handler) };
subscriptions.registerInteractiveHandlers = () => {};
const dispatched: any[] = [];
const subscribed = { children: new Set<string>(), current: { rootSessionId: "native-thread", supportsSubagents: false,
  dispatch: (event: any) => dispatched.push(event), enqueueInteraction: () => { throw new Error("Usage entered the interaction-only route"); } } };
subscriptions.discover(subscribed, { method: "item/started", params: { threadId: "native-thread", item: {
  type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["native-child"],
} } });
const childCompletion = { method: "rawResponse/completed", params: {
  threadId: "native-child", turnId: "child-turn", responseId: "child-response", usage: rawUsage,
} };
nativeHandlers.get("native-child")!({ ...childCompletion, params: { ...childCompletion.params, threadId: "unrelated-thread" } });
assert.equal(dispatched.length, 0);
nativeHandlers.get("native-child")!(childCompletion);
assert.equal(dispatched.length, 1);
assert.equal(dispatched[0]._remiUsageRootSessionId, "native-thread");
const childUsage = await responseHandler.createUpdateEvent(dispatched[0]);
assert.equal(childUsage._meta.remiTokenUsage.providerSessionId, "native-child");
assert.equal(childUsage._meta.remiTokenUsage.requestedModel, null);
assert.equal(childUsage._meta.remiTokenUsage.modelSource, "unknown");
// app-server sends rawResponse/completed only for threads whose thread/start
// opted into raw events (codex 0.161.0 and 0.162.1); without that the hook
// above never runs. resume/fork cannot opt in and use the native rollout.
const rawStart = patched.indexOf("    const response = await this.codexClient.threadStart({/*remi-usage:begin*/\n      experimentalRawEvents: true,");
assert(rawStart >= 0 && patched.startsWith("\n  async newSession(request) {", patched.lastIndexOf("\n  async ", rawStart)),
  "The published newSession must opt thread/start into raw response events");
const initializeStart = patched.indexOf("  async initialize(request) {\n    const response = await this.codexClient.initialize({");
const initializeEnd = patched.indexOf("\n  }\n", initializeStart);
assert(initializeStart >= 0 && initializeEnd > initializeStart, "Inspect the new bridge's app-server initialize");
const Initializer = new Function(`return class { ${patched.slice(initializeStart, initializeEnd + 4)} }`)();
const initializer = new Initializer();
let appServerInitialize: any;
initializer.codexClient = { initialize: async (params: any) => { appServerInitialize = params; return {}; } };
initializer.defaultClientInfo = { name: bridge.name, title: "Codex ACP", version: bridge.version };
await initializer.initialize({});
assert.equal(appServerInitialize.capabilities.experimentalApi, true);
assert.deepEqual(appServerInitialize.capabilities.optOutNotificationMethods, ["rawResponseItem/completed"]);
if (args.includes("--usage-only")) {
  console.log(JSON.stringify({ bridge: bridge.version, codex: codex.version, cliVersion,
    usagePatch: CODEX_USAGE_PATCH, usageHook: "passed", sessionNegotiation: "not_run" }));
  process.exit(0);
}

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
let invalidUsageUpdates = 0;
// Streamed request usage by native identity (thread, response).
const streamed = new Map<string, any>();
const bridgeClient = () => new AcpClient({
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
      if (update._meta?.remiUsagePatch !== CODEX_USAGE_PATCH || update._meta?.remiUsageMode !== "request") invalidUsageUpdates++;
      const usage = update._meta?.remiTokenUsage as any;
      if (usage) streamed.set(JSON.stringify([usage.providerSessionId, usage.providerRequestId]), usage);
    }
  },
});
let client = bridgeClient();
const requestUsage: Record<string, { streamed: number; rollout: number }> = {};
const timeoutMs = args.includes("--prompt") ? 240_000 : 120_000;
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  void client.stop();
}, timeoutMs);
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
    const rollout = beginCodexRolloutUsage(isolatedHome, session.sessionId);
    const result = await client.prompt(session.sessionId, "Reply with exactly REMI_CODEX_BRIDGE_OK. Do not use tools.");
    assert.equal(result.stopReason, "end_turn");
    assert(text.includes("REMI_CODEX_BRIDGE_OK"));
    assert(streamed.size > 0, "A new thread must stream rawResponse/completed request usage");
    assert.equal(invalidUsageUpdates, 0, "All streamed usage must carry the Remi patch");
    // The daemon also reads the native rollout. Both sources must name the
    // same requests with the same counters, or the merge would double count.
    const recorded = await collectCodexRolloutUsage(rollout, { waitMs: 2_000 });
    for (const usage of streamed.values()) {
      const match = recorded.find(({ usage: native }) => native.providerSessionId === usage.providerSessionId
        && native.providerRequestId === usage.providerRequestId);
      assert(match, `The rollout lacks streamed request ${usage.providerRequestId}`);
      for (const key of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "totalTokens"]) {
        assert.equal(match.usage[key], usage[key], `${key} differs between the stream and the rollout`);
      }
    }
    requestUsage.newThread = { streamed: streamed.size, rollout: recorded.length };
  }
  console.log("Checking ACP session/close...");
  await client.closeSession(session.sessionId);
  if (args.includes("--prompt")) {
    // A daemon restart resumes the thread in a new bridge process; thread/resume
    // cannot opt into raw events, so only the rollout carries its requests.
    console.log("Checking resumed-thread request usage from the native rollout...");
    await client.stop();
    client = bridgeClient();
    await client.start();
    await client.initialize();
    const resumed = await client.resumeSession(session.sessionId, cwd, []);
    streamed.clear();
    text = "";
    const rollout = beginCodexRolloutUsage(isolatedHome, resumed.sessionId);
    const result = await client.prompt(resumed.sessionId, "Reply with exactly REMI_CODEX_RESUME_OK. Do not use tools.");
    assert.equal(result.stopReason, "end_turn");
    assert(text.includes("REMI_CODEX_RESUME_OK"));
    const recorded = await collectCodexRolloutUsage(rollout, { waitMs: 2_000 });
    assert(recorded.length > 0 && recorded.every(({ threadId, usage }) => threadId === session.sessionId && usage.accuracy === "exact"),
      "A resumed thread's requests must be recorded in its rollout");
    requestUsage.resumedThread = { streamed: streamed.size, rollout: recorded.length };
    await client.closeSession(resumed.sessionId);
  }
  console.log(JSON.stringify({
    bridge: bridge.version, codex: codex.version, cliVersion,
    usagePatch: CODEX_USAGE_PATCH, protocolVersion: initialized.protocolVersion,
    model: model.currentValue, effort: effort.currentValue,
    modelCatalog: session.models?.availableModels.map((entry) => entry.modelId),
    prompt: args.includes("--prompt") ? "passed" : "not-run", requestUsage,
    status: "passed",
  }, null, 2));
} catch (error) {
  if (timedOut) throw new Error(`Codex bridge verification timed out after ${timeoutMs / 1000} seconds`, { cause: error });
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
