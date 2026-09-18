import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AgentResponse, Provider, ProviderEvent, SendOptions } from "@shared/contracts/provider-types.js";
import { createAgentResponse } from "@shared/contracts/provider-types.js";
import type { AcpModelCapability, AcpProviderOptions } from "./provider.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_LOG = 32 * 1024 * 1024;
const MANAGED_VALUE_FLAGS = new Set(["-p", "--prompt", "--print", "-i", "--prompt-interactive", "--conversation", "--model", "--effort", "--print-timeout", "--log-file", "--settings", "--input-format", "--output-format", "--mode", "--json-schema", "--project", "--new-project"]);
const MANAGED_FLAGS = new Set(["-c", "--continue", "--dangerously-skip-permissions"]);

/** Keep the task's prompt, identity, permissions and output framing authoritative. */
export function filterAntigravityArgs(args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=", 1)[0]!;
    if (MANAGED_VALUE_FLAGS.has(flag)) {
      if (!arg.includes("=") && args[i + 1] && !args[i + 1]!.startsWith("-")) i++;
    } else if (arg !== "--" && !/^-[pic].+/.test(arg) && !MANAGED_FLAGS.has(flag)) kept.push(arg);
  }
  return kept;
}

export function resolveAntigravityExecutable(executable?: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = executable || env.MULTIREMI_ANTIGRAVITY_PATH;
  if (configured) return configured;
  const local = process.platform === "win32"
    ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
    : join(homedir(), ".local", "bin", "agy");
  return existsSync(local) ? local : "agy";
}

export function antigravityCliVersion(): string | null {
  try {
    return execFileSync(resolveAntigravityExecutable(), ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null;
  } catch { return null; }
}

/** Catalog IDs are CLI values, including spaces on older single-column releases. */
export function parseAntigravityModels(output: string): AcpModelCapability[] {
  const models = new Map<string, AcpModelCapability>();
  for (const raw of output.split(/\r?\n/)) {
    const [id, label] = raw.split("\t").map(value => value.trim());
    if (!id || /^(Fetching |Error:|Warning:|Please sign in|Available models:?$)/i.test(id)) continue;
    if (!models.has(id)) models.set(id, { id, label: label || id, default: false });
  }
  return [...models.values()];
}

export function parseAntigravityLog(log: string): { sessionId: string | null; appDataDir: string | null; error: string | null } {
  const last = (pattern: RegExp) => [...log.matchAll(pattern)].at(-1)?.[1]?.trim() ?? null;
  const sessionId = last(/conversation=([a-f0-9-]{36})/gi);
  return {
    sessionId: sessionId && UUID.test(sessionId) ? sessionId : null,
    appDataDir: last(/CLI app data directory:\s*([^\r\n]+)/g),
    error: /Print mode: timed out after \d+ polls/.test(log)
      ? "agy print mode timed out waiting for the response"
      : last(/agent executor error:\s*([^\r\n]+)/g),
  };
}

/** A resumed transcript contains earlier turns; only the last USER_INPUT owns the reply. */
export function parseAntigravityTranscript(transcript: string): string {
  let parts: string[] = [];
  let currentTurn = false;
  for (const line of transcript.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type === "USER_INPUT") { parts = []; currentTurn = true; }
    else if (currentTurn && item.type === "PLANNER_RESPONSE" && item.source === "MODEL"
      && item.status === "DONE" && typeof item.content === "string" && item.content.trim()) parts.push(item.content);
  }
  return parts.join("\n\n");
}

function textEvent(text: string): ProviderEvent {
  return { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] };
}

function safeDiagnostic(value: string, env: NodeJS.ProcessEnv): string {
  let text = value;
  for (const [key, secret] of Object.entries(env)) {
    if (secret && secret.length >= 8 && /TOKEN|KEY|SECRET|PASSWORD/i.test(key)) text = text.split(secret).join("[redacted]");
  }
  return text.slice(-2000);
}

async function readBounded(path: string, limit = MAX_LOG): Promise<string> {
  try {
    if (!statSync(path).isFile() || statSync(path).size > limit) return "";
    return await readFile(path, "utf8");
  } catch { return ""; }
}

/** Native CLI provider. Emits Remi's shared events without pretending agy speaks ACP. */
export class AntigravityProvider implements Provider {
  readonly name = "antigravity";
  private lastResponse: AgentResponse | null = null;
  private children = new Set<ChildProcess>();
  private capabilities: Promise<{ stream: boolean; stdin: boolean; effort: boolean }> | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly executable: string;
  private readonly prefix: string[];

  constructor(private readonly options: AcpProviderOptions = {}) {
    this.env = { ...process.env, ...options.env };
    this.executable = resolveAntigravityExecutable(options.executable, this.env);
    this.prefix = filterAntigravityArgs(options.args ?? []);
  }

  getLastResponse(): AgentResponse | null { return this.lastResponse; }
  async send(message: string, options: SendOptions = {}): Promise<AgentResponse> {
    for await (const _event of this.sendStream(message, options)) { /* consume */ }
    return this.lastResponse!;
  }
  async healthCheck(): Promise<boolean> {
    try { return (await this.inspect(["--version"])).code === 0; } catch { return false; }
  }
  async discoverModelCapabilities(): Promise<AcpModelCapability[]> {
    const result = await this.inspect(["models"]);
    if (result.code !== 0 || /(?:^|\n)Error:|Please sign in/i.test(result.output)) {
      throw new Error("Antigravity model discovery failed; sign in with agy on this Runtime and retry");
    }
    const models = parseAntigravityModels(result.output);
    if (!models.length) throw new Error("agy models returned no available models");
    if ((await this.getCapabilities()).effort) {
      for (const model of models) model.effort = { supportedLevels: ["low", "medium", "high"].map(value => ({ value, label: value })) };
    }
    return models;
  }
  async close(): Promise<void> { await Promise.all([...this.children].map(child => this.stop(child))); }

  private launch(args: string[], cwd?: string): ChildProcess {
    // argv is never composed into a shell command. Windows uses the native exe.
    const child = spawn(this.executable, [...this.prefix, ...args], {
      cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      detached: process.platform !== "win32" && !this.options.inheritProcessGroup,
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return child;
  }
  private async stop(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      await new Promise<void>(resolveDone => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { child.kill(); resolveDone(); });
        killer.once("close", () => resolveDone());
      });
    } else {
      if (!this.options.inheritProcessGroup) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
      }
      child.kill("SIGKILL");
    }
  }
  private async inspect(args: string[]): Promise<{ output: string; code: number | null }> {
    const child = this.launch(args);
    let output = "";
    const done = new Promise<{ output: string; code: number | null }>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", code => resolveDone({ output, code }));
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", chunk => { if (output.length < MAX_OUTPUT) output += chunk; else void this.stop(child); });
    child.stderr!.resume();
    child.stdin!.on("error", () => {});
    child.stdin!.end();
    const timer = setTimeout(() => void this.stop(child), 10_000);
    try { return await done; } finally { clearTimeout(timer); }
  }
  private getCapabilities() {
    return this.capabilities ??= this.inspect(["--help"]).then(({ output, code }) => {
      if (code !== 0) throw new Error("Could not inspect agy CLI capabilities");
      return { stream: output.includes("--output-format"), stdin: output.includes("--input-format"), effort: output.includes("--effort") };
    }).catch(error => { this.capabilities = null; throw error; });
  }

  async *sendStream(message: string, options: SendOptions = {}): AsyncGenerator<ProviderEvent> {
    this.lastResponse = null;
    options.signal?.throwIfAborted();
    if (options.sessionId && !UUID.test(options.sessionId)) throw new Error("Invalid Antigravity conversation ID");
    if (options.media?.length) throw new Error("Antigravity headless input supports text only; use an attachment path in the prompt");
    if (this.options.getMcpServers?.().length) throw new Error("Antigravity does not support task-scoped MCP configuration; configure native servers with agy mcp");
    if (this.options.pluginPaths?.length) throw new Error("Antigravity does not support Remi Agent Plugins");
    if (options.allowedTools?.length || this.options.allowedTools?.length) throw new Error("Antigravity cannot enforce a Remi tool allowlist");
    const permission = options.permissionMode ?? "bypassPermissions";
    if (!["bypassPermissions", "plan", "acceptEdits"].includes(permission)) {
      throw new Error("Antigravity headless cannot enforce the requested permission mode or Remi interactive approvals; use auto approval or another provider");
    }
    const caps = await this.getCapabilities();
    if (options.effort && (!caps.effort || !["low", "medium", "high"].includes(options.effort))) {
      throw new Error("Antigravity does not advertise the requested reasoning effort");
    }
    const model = options.model || this.options.model || this.env.MULTIREMI_ANTIGRAVITY_MODEL;
    if (model) {
      // Like the source integration, discovery outages do not invent a catalog.
      const models = await this.discoverModelCapabilities().catch(() => []);
      if (models.length && !models.some(item => item.id === model)) throw new Error(`Antigravity model ${JSON.stringify(model)} is not available from agy models`);
    }
    const cwd = options.cwd || this.options.cwd || process.cwd();
    const contextDir = this.env.MULTIREMI_ANTIGRAVITY_CONTEXT_DIR;
    const localContext = contextDir ? await readBounded(join(contextDir, "AGENTS.md"), 256 * 1024) : "";
    const prompt = [options.systemPrompt, options.context, localContext, message].filter(Boolean).join("\n\n");
    const directory = await mkdtemp(join(tmpdir(), "remi-agy-"));
    const logPath = join(directory, "run.log");
    const started = Date.now();
    const timeoutMs = options.deadlineMs != null ? Math.max(1, options.deadlineMs - started) : this.options.timeout ? this.options.timeout * 1000 : 24 * 60 * 60 * 1000;
    const args = ["--log-file", logPath, "--print-timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`];
    if (permission === "plan" || permission === "acceptEdits") args.push("--mode", permission === "plan" ? "plan" : "accept-edits");
    else args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.sessionId) args.push("--conversation", options.sessionId);
    for (const path of new Set([cwd, ...(contextDir ? [contextDir] : []), ...(options.addDirs ?? [])])) args.push("--add-dir", resolve(path));
    if (caps.stream) args.push("--output-format", "stream-json");
    if (caps.stream && caps.stdin) args.push("--input-format", "stream-json");
    else args.push("-p", prompt);

    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout = false;
    let stdout = "";
    let stderr = "";
    let sessionId = options.sessionId ?? null;
    let result: Record<string, any> | null = null;
    let bytes = 0;
    const toolsSeen = new Set<string>();
    const cancel = () => { if (child) void this.stop(child); };
    try {
      options.signal?.throwIfAborted();
      child = this.launch(args, cwd);
      const outcome = new Promise<{ code: number | null; error?: Error }>(resolveDone => {
        child!.once("error", error => resolveDone({ code: null, error }));
        child!.once("close", code => resolveDone({ code }));
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
      child.stdin!.on("error", () => {});
      timer = setTimeout(() => { timeout = true; cancel(); }, timeoutMs);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stdin!.end(caps.stream && caps.stdin ? JSON.stringify({ event: "user", message: { content: prompt } }) + "\n" : undefined);
      if (caps.stream) {
        const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of lines) {
          bytes += Buffer.byteLength(line);
          if (bytes > MAX_OUTPUT) throw new Error("Antigravity output exceeded 16 MiB");
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { throw new Error("Invalid Antigravity JSON event stream"); }
          const id = event.conversation_id ?? event.step_update?.conversation_id ?? event.result?.conversation_id;
          if (typeof id === "string" && UUID.test(id)) {
            if (options.sessionId && id !== options.sessionId) throw new Error("Stale provider session: no conversation found for the requested Antigravity ID");
            sessionId = id;
            this.lastResponse = createAgentResponse({ text: stdout, sessionId, model: model ?? null, durationMs: Date.now() - started });
          }
          if (event.event === "result") {
            if (result) throw new Error("Antigravity emitted more than one result for a turn");
            result = event.result;
          }
          const step = event.event === "step_update" ? event.step_update : null;
          if (step?.step_type === "agent_response" && typeof step.text_delta === "string") {
            stdout += step.text_delta;
            yield textEvent(step.text_delta);
          } else if (step?.step_type === "tool") {
            const toolId = `agy-${step.step_index}`;
            const info = step.tool_info ?? {};
            const title = String(step.tool_name ?? info.name ?? "tool");
            const status = info.error ? "failed" : step.state === "DONE" ? "completed" : "in_progress";
            const content = info.output == null ? [] : [{ type: "content" as const, content: { type: "text" as const, text: typeof info.output === "string" ? info.output : JSON.stringify(info.output) } }];
            if (!toolsSeen.has(toolId)) {
              toolsSeen.add(toolId);
              yield { sessionUpdate: "tool_call", toolCallId: toolId, title, status, rawInput: info.parameters, content };
            } else yield { sessionUpdate: "tool_call_update", toolCallId: toolId, title, status, rawInput: info.parameters, content };
          }
        }
      } else {
        child.stdout!.setEncoding("utf8");
        for await (const chunk of child.stdout!) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_OUTPUT) throw new Error("Antigravity output exceeded 16 MiB");
          stdout += chunk;
          yield textEvent(chunk);
        }
      }
      const exit = await outcome;
      const log = parseAntigravityLog(await readBounded(logPath));
      if (options.sessionId && log.sessionId && log.sessionId !== options.sessionId) {
        throw new Error("Stale provider session: no conversation found for the requested Antigravity ID");
      }
      sessionId = sessionId ?? log.sessionId;
      this.lastResponse = createAgentResponse({ text: stdout, sessionId, model: model ?? null, durationMs: Date.now() - started });
      options.signal?.throwIfAborted();
      if (timeout) throw new Error("Antigravity task timed out");
      if (exit.error) throw new Error(`Could not start agy: ${exit.error.message}`);
      if (exit.code !== 0 || log.error) throw new Error(safeDiagnostic(log.error || `agy exited with code ${exit.code}: ${stderr}`, this.env));
      if (caps.stream && (!result || result.status !== "SUCCESS")) {
        throw new Error(safeDiagnostic(`Antigravity ${result?.status ?? "missing terminal result"}: ${result?.error ?? stderr}`, this.env));
      }
      let finalText = typeof result?.response === "string" ? result.response : stdout;
      if (!finalText.trim() && sessionId && log.appDataDir) {
        const transcript = await readBounded(join(log.appDataDir, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"));
        finalText = parseAntigravityTranscript(transcript);
      }
      if (!finalText.trim()) throw new Error("Antigravity completed without a response; no current-turn transcript was available");
      if (!stdout) yield textEvent(finalText);
      else if (finalText.startsWith(stdout) && finalText.length > stdout.length) yield textEvent(finalText.slice(stdout.length));
      const usage = result?.usage ?? {};
      const count = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : null;
      this.lastResponse = createAgentResponse({
        text: finalText, sessionId, model: model ?? null, durationMs: Date.now() - started,
        inputTokens: count("input_tokens"), outputTokens: count("output_tokens"),
        cacheReadInputTokens: count("cache_read_tokens"), totalTokens: count("total_tokens"),
        metadata: { outputFormat: caps.stream ? "stream-json" : "text" },
      });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (child) await this.stop(child);
      await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
}
