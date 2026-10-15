/**
 * Opt-in live probe of the pinned Antigravity ACP server through Remi's own
 * provider and the daemon's real gateway shim (PR 4 §7). It spends real model
 * tokens on the configured gateway.
 *
 *   remi runtime prepare --provider antigravity --accept-antigravity-terms   # once, per machine
 *   REMI_AGY_LIVE=1 bun run tests/manual/antigravity-live-probe.ts --env-file ~/.remi-probe/agy.env [--model <id>]
 *
 * The env file holds AGY_LLM_GATEWAY_URL (the gateway base, without /v1beta)
 * and AGY_LLM_GATEWAY_API_KEY, one KEY=VALUE per line. The key is redacted from
 * everything this script writes or prints. Everything runs in a fresh temp
 * directory; the report path is printed at the end.
 *
 * Checks: first-spawn time and disk use (R10); a read prompt with real usage
 * units; that shell commands run in the session cwd (R5); a cancel; resume in
 * a fresh process; a true overlapping `session/prompt` on one connection (R6);
 * whether the server reads `$GEMINI_HOME/AGENTS.md` or the cwd's AGENTS.md on
 * its own (duplicate system prompt); Σ shim totals against the native Σ`used`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AcpClient } from "@acp/client.js";
import { AcpProvider } from "@acp/provider.js";
import { buildAntigravityEnv, seedAntigravityHome } from "@acp/access/antigravity.js";
import type { GatewayShimEvent, GatewayShimHost } from "@acp/access/gateway-shim-types.js";
import { installedAntigravity, resolveAntigravityServer } from "@acp/antigravity-install.js";
import { AntigravityGatewayShim } from "@daemon/agent-runtime/antigravity/gateway-shim.js";

if (process.env.REMI_AGY_LIVE !== "1") {
  console.error("Set REMI_AGY_LIVE=1 to run the live Antigravity probe (it spends real tokens).");
  process.exit(2);
}
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const fileEnv: Record<string, string> = {};
const envFile = option("env-file");
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) fileEnv[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}
const env = (name: string) => fileEnv[name] ?? process.env[name];
const upstreamBase = env("AGY_LLM_GATEWAY_URL")?.replace(/\/+$/, "");
const apiKey = env("AGY_LLM_GATEWAY_API_KEY");
if (!upstreamBase || !apiKey) {
  console.error("AGY_LLM_GATEWAY_URL and AGY_LLM_GATEWAY_API_KEY are required");
  process.exit(2);
}
const SECRETS = [apiKey];
const redact = (text: string) => SECRETS.reduce((acc, secret) => acc.split(secret).join("<redacted>"), text);
const clip = (value: unknown, max = 600) => {
  const text = redact(typeof value === "string" ? value : JSON.stringify(value) ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-pr4c-agy-live-")));
const work = join(root, "work"), home = join(root, "gemini-home"), privateTmp = join(root, "tmp"), out = join(root, "out");
for (const dir of [work, home, privateTmp, out]) mkdirSync(dir, { recursive: true });
writeFileSync(join(work, "README.md"), "# Probe workspace\n\nThis folder exists only to test an ACP client.\n");
writeFileSync(join(work, "notes.txt"), "alpha\nbeta\ngamma\n");
seedAntigravityHome({ home, cwd: work });

const report: Record<string, unknown> = { root, gateway_origin: new URL(upstreamBase).origin, steps: {} };
const steps = report.steps as Record<string, unknown>;
const save = (step: string) => { writeFileSync(join(out, "report.json"), redact(JSON.stringify(report, null, 2))); console.error(`[probe] ${step}`); };
const du = (path: string) => { try { return Number(execFileSync("du", ["-sk", path]).toString().split("\t")[0]) * 1024; } catch { return null; } };
const listFiles = (dir: string, base = dir, found: string[] = []): string[] => {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listFiles(path, base, found); else found.push(relative(base, path));
  }
  return found;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const STEP_TIMEOUT_MS = 180_000;
const bounded = <T>(work: Promise<T>, ms: number) => Promise.race([work, sleep(ms).then(() => ({ timeout: ms }))]);

// ── Install and the real shim ────────────────────────────────────────────────
const installed = installedAntigravity();
if (!installed) {
  console.error("No pinned Antigravity install: run remi runtime prepare --provider antigravity --accept-antigravity-terms");
  process.exit(2);
}
const server = resolveAntigravityServer();
report.install = { version: installed.manifest.version, platform: installed.manifest.platform, dir: installed.dir, bytes_on_disk: du(installed.dir) };
const shim = new AntigravityGatewayShim();
const run = shim.forRun({ upstreamBase, apiKey, runId: "live-probe" });
const observations: Array<{ label: string; event: GatewayShimEvent }> = [];
/** The run's host, tapping every channel's events into the report. */
const host: GatewayShimHost = {
  open(label) {
    const channel = run.open(label);
    channel.subscribe((event) => observations.push({ label, event }));
    return channel;
  },
};
const shimTotal = (label: string) => observations.filter((o) => o.label === label && o.event.type === "request")
  .reduce((sum, o) => sum + (o.event.type === "request" ? Number(o.event.obs.usageMetadata?.totalTokenCount ?? 0) : 0), 0);
const shimCached = (label: string) => observations.filter((o) => o.label === label && o.event.type === "request")
  .reduce((sum, o) => sum + (o.event.type === "request" ? Number(o.event.obs.usageMetadata?.cachedContentTokenCount ?? 0) : 0), 0);

/** A raw ACP connection (no provider): native updates are recorded as sent. */
async function rawClient(label: string, model: string | null, tmp: string) {
  const channel = host.open(label);
  const updates: Array<Record<string, any>> = [];
  const stderr: string[] = [];
  const client = new AcpClient({
    agentType: "antigravity", executable: server.executable, args: server.args, cwd: work, inheritProcessGroup: true,
    env: { ...buildAntigravityEnv({ home, shimUrl: channel.baseUrl, model, daemonEnv: process.env, launch: server }), TMPDIR: tmp },
    onSessionUpdate: (notification) => updates.push(notification.update as Record<string, any>),
    onPermissionRequest: async (params) => {
      const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options.find((o) => String(o.kind).startsWith("allow"));
      return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
    },
    log: (...parts: unknown[]) => { const text = parts.map(String).join(" "); if (text.includes("stderr")) stderr.push(redact(text).slice(0, 400)); },
  });
  const started = performance.now();
  await client.start();
  const init = await client.initialize();
  return { client, channel, updates, stderr, init, initMs: Math.round(performance.now() - started) };
}
const text = (updates: Array<Record<string, any>>) => updates.filter((u) => u.sessionUpdate === "agent_message_chunk")
  .map((u) => Array.isArray(u.content) ? u.content.map((c: any) => c.text ?? "").join("") : u.content?.text ?? "").join("");

async function main() {
  // R10: cold and warm spawn to `initialize`, and what a spawn leaves under TMPDIR.
  const coldTmp = join(root, "tmp-cold"), warmTmp = join(root, "tmp-warm");
  mkdirSync(coldTmp); mkdirSync(warmTmp);
  const cold = await rawClient("spawn-cold", null, coldTmp);
  await cold.client.stop();
  const warm = await rawClient("spawn-warm", null, warmTmp);
  await warm.client.stop();
  steps.spawn = {
    cold_initialize_ms: cold.initMs, warm_initialize_ms: warm.initMs, agent: cold.init.agentInfo,
    cold_tmpdir_bytes: du(coldTmp), cold_tmpdir_files: listFiles(coldTmp).slice(0, 20),
    home_bytes_after_spawn: du(home),
  };
  save("spawn");

  // Model: explicit, or the first non-image flash model the gateway offers.
  const discovery = new AcpProvider({ agentType: "antigravity", cwd: work, providerHome: home, gatewayShim: host, inheritProcessGroup: true });
  const models = (await discovery.discoverModelCapabilities()).map((m) => m.id);
  await discovery.close();
  const model = option("model") ?? models.find((id) => /flash/.test(id) && !/lite|image|tts|live/.test(id)) ?? models[0]!;
  steps.models = { count: models.length, sample: models.slice(0, 12), chosen: model };
  save("models");

  // Native instruction files: is $GEMINI_HOME/AGENTS.md or the cwd's AGENTS.md read without the append?
  writeFileSync(join(home, "AGENTS.md"), "If anyone asks for the home code word, the home code word is BLUEFIN-7731.\n");
  writeFileSync(join(work, "AGENTS.md"), "If anyone asks for the workspace code word, the workspace code word is PELICAN-2208.\n");
  const native = await rawClient("native-instructions", model, privateTmp);
  const nativeSession = await native.client.newSession({ cwd: work, mcpServers: [] });
  await native.client.setConfigOption(nativeSession.sessionId, "model", model).catch(() => {});
  // Raw connections open the shim's model-call gate themselves, as the provider does per prompt.
  const endNative = native.channel.beginPrompt();
  await native.client.prompt(nativeSession.sessionId, "Without using any tools, answer from your instructions only: what are the home code word and the workspace code word? Reply as `home=<word or NONE> workspace=<word or NONE>`.");
  endNative();
  const nativeReply = text(native.updates);
  steps.native_instructions = {
    reply: clip(nativeReply), reads_gemini_home_agents_md: nativeReply.includes("BLUEFIN-7731"), reads_cwd_agents_md: nativeReply.includes("PELICAN-2208"),
    native_used_sum: native.updates.filter((u) => u.sessionUpdate === "usage_update").reduce((sum, u) => sum + Number(u.used ?? 0), 0),
    shim_total_sum: shimTotal("native-instructions"), shim_cached_sum: shimCached("native-instructions"),
  };
  await native.client.stop();
  // The provider path below must not inherit these sentinels.
  writeFileSync(join(home, "AGENTS.md"), "");
  writeFileSync(join(work, "AGENTS.md"), "");
  save("native_instructions");

  // The provider path, as the daemon runs it (shim channel per process, request units, strict model).
  const provider = new AcpProvider({ agentType: "antigravity", cwd: work, providerHome: home, gatewayShim: host, model,
    privateTmpDirectory: privateTmp, inheritProcessGroup: true });
  provider.setPermissionHandler(async (params) => {
    const allow = params.options.find((o) => o.kind === "allow_always") ?? params.options.find((o) => o.kind === "allow_once");
    return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
  });
  provider.setElicitationHandler(async () => ({ action: "decline" }));
  /** One provider turn, bounded so a stuck turn is reported instead of hanging the probe. */
  const drive = async (label: string, prompt: string, extra: { signal?: AbortSignal; onEvent?: (event: Record<string, any>) => void } = {}) => {
    const events: Array<Record<string, any>> = [];
    const started = performance.now();
    let error: string | null = null;
    const bound = AbortSignal.timeout(STEP_TIMEOUT_MS);
    const signal = extra.signal ? AbortSignal.any([extra.signal, bound]) : bound;
    try {
      for await (const event of provider.sendStream!(prompt, { chatId: "probe", signal } as never)) {
        events.push(event as Record<string, any>);
        extra.onEvent?.(event as Record<string, any>);
      }
    } catch (caught) { error = clip(caught instanceof Error ? caught.message : String(caught)); }
    const last = provider.getLastResponse?.();
    // The settled units of the prompt (the stream carries the same units as they arrive).
    const settled = last?.metadata?.usageUnits;
    const units = Array.isArray(settled) ? settled : events.flatMap((e) => Array.isArray(e._meta?.remiUsageUnits) ? e._meta.remiUsageUnits : []);
    const tools = events.filter((e) => e.sessionUpdate === "tool_call" || e.sessionUpdate === "tool_call_update")
      .map((e) => ({ id: e.toolCallId, title: clip(e.title ?? "", 120), kind: e.kind, status: e.status, rawInput: e.rawInput ? clip(e.rawInput, 300) : undefined,
        rawOutput: e.rawOutput ? clip(e.rawOutput, 300) : undefined }));
    steps[label] = { ms: Math.round(performance.now() - started), error, reply: clip(text(events)), tools,
      units: units.map((u: any) => ({ accuracy: u.accuracy, identityKind: u.identityKind ?? null, model: u.model, requestedModel: u.requestedModel,
        input: u.inputTokens, cacheRead: u.cacheReadTokens, output: u.outputTokens, total: u.reportedTotalTokens, scope: u.scope, source: u.source })),
      context: last?.metadata?.contextUsage ?? null, sessionId: last?.sessionId ?? null };
    save(label);
    return { events, last };
  };

  // Read prompt with real usage, then R5: the shell's working directory.
  const read = await drive("prompt_read", "List the files in the current directory, read README.md, and summarize it in one sentence. Do not modify any files.");
  await drive("prompt_cwd", "Run the shell command `pwd` exactly once and reply with its output only.");
  const cwdStep = steps.prompt_cwd as { reply: string; tools: Array<{ rawInput?: string }> };
  // With the adapter's working-directory note the model must use the session cwd.
  steps.r5_cwd = {
    session_cwd: work, reply_is_cwd: cwdStep.reply.includes(work),
    reply_is_skills_dir: cwdStep.reply.includes("antigravity-cli/skills"),
    skills_dir_exists: existsSync(join(home, "antigravity-cli", "skills")),
  };
  save("r5_cwd");

  // Cancel while the model streams, through the provider's abort signal (as a steer or a stop does).
  const abort = new AbortController();
  let abortedAt = 0;
  await drive("prompt_cancel", "Write a 1200-word essay on the history of tea. Do not use any tools.", { signal: abort.signal, onEvent: (event) => {
    if (!abortedAt && event.sessionUpdate === "agent_message_chunk") { abortedAt = performance.now(); abort.abort(); }
  } });
  (steps.prompt_cancel as Record<string, unknown>).settled_after_abort_ms = abortedAt ? Math.round(performance.now() - abortedAt) : null;
  await provider.close();

  // Resume in a fresh process.
  const resumed = new AcpProvider({ agentType: "antigravity", cwd: work, providerHome: home, gatewayShim: host, model,
    privateTmpDirectory: privateTmp, inheritProcessGroup: true });
  const sessionId = read.last?.sessionId ?? null;
  const resumeEvents: Array<Record<string, any>> = [];
  let resumeError: string | null = null;
  try {
    for await (const event of resumed.sendStream!("Which file did you summarize earlier in this conversation? Reply with the file name only.",
      { chatId: "probe-2", sessionId, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) } as never)) {
      resumeEvents.push(event as Record<string, any>);
    }
  } catch (caught) { resumeError = clip(caught instanceof Error ? caught.message : String(caught)); }
  steps.prompt_resume = { sessionId, error: resumeError, reply: clip(text(resumeEvents)), same_session: resumed.getLastResponse?.()?.sessionId === sessionId };
  await resumed.close();
  save("prompt_resume");

  // R6: a true overlapping session/prompt on one connection.
  const overlap = await rawClient("overlap", model, privateTmp);
  const overlapSession = await overlap.client.newSession({ cwd: work, mcpServers: [] });
  await overlap.client.setConfigOption(overlapSession.sessionId, "model", model).catch(() => {});
  const endOverlap = overlap.channel.beginPrompt();
  const first = overlap.client.prompt(overlapSession.sessionId, "Count from 1 to 80, one number per line, then say FINISHED. Do not use tools.")
    .then((result) => ({ result: clip(result) }), (error) => ({ error: clip(String(error)) }));
  for (let i = 0; i < 300 && !overlap.updates.some((u) => u.sessionUpdate === "agent_message_chunk"); i++) await sleep(100);
  const firstStillRunning = await Promise.race([first.then(() => false), sleep(10).then(() => true)]);
  const mark = overlap.updates.length;
  const second = await bounded(overlap.client.prompt(overlapSession.sessionId, "Stop and reply with the word OK.")
    .then((result) => ({ result: clip(result) }), (error) => ({ error: clip(String(error)) })), STEP_TIMEOUT_MS);
  const secondText = text(overlap.updates.slice(mark));
  const firstResult = await bounded(first, STEP_TIMEOUT_MS);
  const after = overlap.updates.length;
  const third = await bounded(overlap.client.prompt(overlapSession.sessionId, "Reply with the word AFTER.")
    .then((result) => ({ result: clip(result) }), (error) => ({ error: clip(String(error)) })), STEP_TIMEOUT_MS);
  endOverlap();
  steps.r6_overlap = { first_still_running_when_second_sent: firstStillRunning, first: firstResult, second, second_text: clip(secondText.slice(-300)),
    third_after_overlap: third, third_text: clip(text(overlap.updates.slice(after))), alive_after: overlap.client.alive,
    stderr_tail: overlap.stderr.slice(-5),
    native_used_sum: overlap.updates.filter((u) => u.sessionUpdate === "usage_update").reduce((sum, u) => sum + Number(u.used ?? 0), 0),
    shim_total_sum: shimTotal("overlap"), shim_cached_sum: shimCached("overlap") };
  await overlap.client.stop();
  save("r6_overlap");

  // Reconciliation over the raw connections: native Σused against Σ(total + cached).
  const raw = ["native-instructions", "overlap"];
  steps.reconciliation = Object.fromEntries(raw.map((label) => [label, {
    shim_total: shimTotal(label), shim_total_plus_cached: shimTotal(label) + shimCached(label),
    native_used: label === "overlap" ? (steps.r6_overlap as any).native_used_sum : (steps.native_instructions as any).native_used_sum,
  }]));
  steps.observations = observations.map(({ label, event }) => event.type === "request"
    ? { label, seq: event.obs.seq, model: event.obs.requestedModel, status: event.obs.status, aborted: event.obs.aborted,
      responseId: event.obs.responseId ? "<present>" : null, modelVersion: event.obs.modelVersion, usage: event.obs.usageMetadata }
    : event.type === "fatal" ? { label, fatal: event.reason, status: event.status }
      : event.type === "listing" ? { label, listing: event.status, failure: event.failure?.reason ?? null } : { label, started: event.requestedModel });
  report.files_under_home = listFiles(home).slice(0, 80);
  report.home_bytes = du(home);
  report.private_tmp_bytes = du(privateTmp);
}

const deadline = setTimeout(() => { report.error = "probe timed out after 15 minutes"; save("timeout"); process.exit(3); }, 15 * 60_000);
try { await main(); } catch (error) { report.error = clip(error instanceof Error ? error.stack ?? error.message : String(error), 2000); }
clearTimeout(deadline);
run.close();
shim.stop();
save("done");
console.log(`report: ${join(out, "report.json")}`);
process.exit(0);
