/**
 * ACP Auto Mode Classifier 诊断脚本
 *
 * 捕获 claude-agent-acp 子进程的完整通信，包括：
 * - JSON-RPC stdin/stdout 双向消息
 * - ANTHROPIC_LOG=debug 的 HTTP 调试日志 (stderr)
 * - 原始 SDK 消息 (emitRawSDKMessages)
 * - 权限请求/classifier decision_reason
 *
 * Usage:
 *   bun run scripts/diagnose-auto-mode.ts
 *   bun run scripts/diagnose-auto-mode.ts "列出当前目录文件"
 *   bun run scripts/diagnose-auto-mode.ts --cwd /some/path "prompt here"
 */

import { appendFileSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROMPT = "列出当前目录下的文件";
const TIMEOUT_MS = 120_000;
const DEBUG_LOGS_DIR = `/tmp/remi-diag-debug-${Date.now()}`;

// ── Parse CLI args ──────────────────────────────────────────────

let cwd = process.cwd();
let prompt = DEFAULT_PROMPT;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cwd" && args[i + 1]) {
    cwd = args[++i];
  } else if (!args[i].startsWith("--")) {
    prompt = args[i];
  }
}

// ── Logging ─────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = `/tmp/remi-auto-mode-diag-${timestamp}.log`;
writeFileSync(logFile, "");

function log(tag: string, data: unknown) {
  const line = `[${new Date().toISOString()}] [${tag}] ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`;
  appendFileSync(logFile, line);
  // Also print to console for live monitoring
  const preview = typeof data === "string" ? data : JSON.stringify(data);
  const short = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
  console.log(`[${tag}] ${short}`);
}

// ── Resolve executable ──────────────────────────────────────────

function resolveExecutable(): string {
  const envExe = process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE?.trim();
  if (envExe) return envExe;
  const candidates = [
    join(homedir(), ".npm-global", "bin", "claude-agent-acp"),
  ];
  for (const p of candidates) {
    try {
      if (Bun.file(p).size) return p;
    } catch {}
  }
  return "claude-agent-acp";
}

// ── JSON-RPC transport ──────────────────────────────────────────

let nextId = 1;
let proc: ReturnType<typeof Bun.spawn>;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(msg: Record<string, unknown>) {
  const line = JSON.stringify(msg) + "\n";
  log("TX", msg);
  (proc.stdin as any).write(line);
}

function request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function respond(id: number | string, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

// ── Diagnostics state ───────────────────────────────────────────

interface DiagState {
  sessionId: string | null;
  modes: unknown;
  models: unknown;
  permissionRequests: unknown[];
  sdkMessages: unknown[];
  classifierDecisions: unknown[];
  errors: string[];
  textChunks: string[];
}

const diag: DiagState = {
  sessionId: null,
  modes: null,
  models: null,
  permissionRequests: [],
  sdkMessages: [],
  classifierDecisions: [],
  errors: [],
  textChunks: [],
};

// ── Message handler ─────────────────────────────────────────────

function handleMessage(raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    log("PARSE_ERR", raw.slice(0, 200));
    return;
  }

  // Response to our request
  if ("id" in msg && msg.id != null && !("method" in msg && msg.method)) {
    log("RX:response", msg);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
    return;
  }

  // Server request (permission, fs, etc.)
  if ("id" in msg && msg.id != null && "method" in msg) {
    log("RX:server_request", msg);

    if (msg.method === "session/request_permission") {
      const params = msg.params;
      diag.permissionRequests.push(params);
      log("PERMISSION", {
        toolCall: params?.toolCall,
        options: params?.options,
      });

      // Auto-approve with allow_once to let the flow continue
      const allowOption = params?.options?.find(
        (o: any) => o.kind === "allow_once" || o.kind === "allow_always",
      );
      respond(msg.id, {
        outcome: {
          outcome: "selected",
          optionId: allowOption?.optionId ?? params?.options?.[0]?.optionId ?? "allow",
        },
      });
      return;
    }

    if (msg.method === "fs/readTextFile" || msg.method === "fs/writeTextFile") {
      try {
        const { readFileSync, writeFileSync: wfs } = require("node:fs");
        if (msg.method === "fs/readTextFile") {
          respond(msg.id, { content: readFileSync(msg.params.path, "utf-8") });
        } else {
          wfs(msg.params.path, msg.params.content, "utf-8");
          respond(msg.id, {});
        }
      } catch (err: any) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } });
      }
      return;
    }

    // Unknown server request — respond with method not found
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Not handled: ${msg.method}` } });
    return;
  }

  // Notification
  if ("method" in msg) {
    if (msg.method === "session/update") {
      const update = msg.params?.update;
      const updateType = update?.sessionUpdate;

      switch (updateType) {
        case "agent_message_chunk": {
          const blocks = Array.isArray(update.content) ? update.content : [update.content];
          for (const b of blocks) {
            if (b?.type === "text" && b.text) {
              diag.textChunks.push(b.text);
              log("TEXT", b.text);
            }
          }
          break;
        }
        case "agent_thought_chunk":
          log("THOUGHT", update);
          break;
        case "tool_call":
        case "tool_call_update":
          log("TOOL", {
            type: updateType,
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            status: update.status,
          });
          break;
        case "current_mode_update":
          log("MODE_CHANGE", update);
          break;
        case "usage_update":
          log("USAGE", update);
          break;
        default:
          log(`UPDATE:${updateType}`, update);
      }
      return;
    }

    // Raw SDK messages — this is what we're most interested in
    if (msg.method === "_claude/sdkMessage") {
      const sdkMsg = msg.params?.message;
      diag.sdkMessages.push(sdkMsg);

      // Check for can_use_tool (classifier decision)
      if (sdkMsg?.type === "system" && sdkMsg?.subtype === "control_request") {
        const req = sdkMsg?.request;
        if (req?.subtype === "can_use_tool") {
          const decision = {
            tool_name: req.tool_name,
            decision_reason: req.decision_reason,
            permission_suggestions: req.permission_suggestions,
            blocked_path: req.blocked_path,
            title: req.title,
          };
          diag.classifierDecisions.push(decision);
          log("CLASSIFIER", decision);
        }
      }

      // Check for stream events that reveal model info
      if (sdkMsg?.type === "stream_event") {
        const evt = sdkMsg.event;
        if (evt?.type === "message_start") {
          log("SDK:message_start", {
            model: evt.message?.model,
            usage: evt.message?.usage,
          });
        }
      }

      log("SDK_RAW", sdkMsg);
      return;
    }

    log("NOTIFICATION", msg);
    return;
  }

  log("UNKNOWN", msg);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const executable = resolveExecutable();
  log("INFO", `Executable: ${executable}`);
  log("INFO", `CWD: ${cwd}`);
  log("INFO", `Prompt: ${prompt}`);
  log("INFO", `Log file: ${logFile}`);

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  ACP Auto Mode Classifier 诊断                  ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  Log: ${logFile}`);
  console.log(`║  CWD: ${cwd}`);
  console.log(`║  Prompt: ${prompt.slice(0, 40)}`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // Spawn with debug env vars
  mkdirSync(DEBUG_LOGS_DIR, { recursive: true });
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.ANTHROPIC_LOG = "debug";
  env.CLAUDE_CODE_DEBUG_LOGS_DIR = DEBUG_LOGS_DIR;

  proc = Bun.spawn([executable], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env,
  });

  // Read stdout JSONL
  const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  (async () => {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleMessage(line);
      }
    }
  })();

  // Read stderr (ANTHROPIC_LOG debug output)
  const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const stderrDecoder = new TextDecoder();
  (async () => {
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      const text = stderrDecoder.decode(value, { stream: true });
      if (text.trim()) {
        log("STDERR", text.trim());
      }
    }
  })();

  // Wait for process to be ready
  await Bun.sleep(500);

  // Step 1: Initialize
  console.log("\n── Step 1: Initialize ──");
  const initResult = await request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "remi-diag", version: "0.1.0" },
    clientCapabilities: {
      _meta: { terminal_output: true },
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  log("INIT_RESULT", initResult);

  // Step 2: New session with emitRawSDKMessages + auto mode
  console.log("\n── Step 2: New Session (auto mode + emitRawSDKMessages) ──");
  const sessionResult = await request<any>("session/new", {
    cwd,
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: {
          permissionMode: "auto",
        },
        emitRawSDKMessages: true,
      },
    },
  });
  diag.sessionId = sessionResult.sessionId;
  diag.modes = sessionResult.modes;
  diag.models = sessionResult.models;
  log("SESSION", {
    sessionId: sessionResult.sessionId,
    modes: sessionResult.modes,
    models: sessionResult.models,
  });

  console.log(`  Session: ${sessionResult.sessionId}`);
  console.log(`  Mode: ${sessionResult.modes?.currentModeId}`);
  console.log(`  Available modes: ${sessionResult.modes?.availableModes?.map((m: any) => m.id).join(", ")}`);
  console.log(`  Model: ${sessionResult.models?.currentModelId}`);

  // Step 3: Set mode to auto (may fail — that's informative)
  console.log("\n── Step 3: Set Mode → auto ──");
  try {
    await request("session/set_mode", {
      sessionId: sessionResult.sessionId,
      modeId: "auto",
    });
    log("SET_MODE", "auto → success");
    console.log("  set_mode(auto) succeeded");
  } catch (err: any) {
    log("SET_MODE_ERROR", err.message);
    console.log(`  set_mode(auto) FAILED: ${err.message}`);
    diag.errors.push(`set_mode(auto): ${err.message}`);

    // Try fallback to default
    try {
      await request("session/set_mode", {
        sessionId: sessionResult.sessionId,
        modeId: "default",
      });
      log("SET_MODE_FALLBACK", "default → success");
      console.log("  Fallback to default succeeded");
    } catch (err2: any) {
      log("SET_MODE_FALLBACK_ERROR", err2.message);
    }
  }

  // Step 4: Send prompt
  console.log(`\n── Step 4: Prompt → "${prompt}" ──`);
  console.log("  Waiting for response (timeout: 120s)...\n");

  const promptPromise = request<any>("session/prompt", {
    sessionId: sessionResult.sessionId,
    prompt: [{ type: "text", text: prompt }],
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS),
  );

  let promptResult: any;
  try {
    promptResult = await Promise.race([promptPromise, timeoutPromise]);
    log("PROMPT_RESULT", promptResult);
  } catch (err: any) {
    log("PROMPT_ERROR", err.message);
    diag.errors.push(`prompt: ${err.message}`);
    promptResult = { error: err.message };
  }

  // Step 5: Generate report
  console.log("\n\n════════════════════════════════════════════════════");
  console.log("                 诊断报告");
  console.log("════════════════════════════════════════════════════\n");

  console.log("Session ID:", diag.sessionId);
  console.log("Mode State:", JSON.stringify(diag.modes, null, 2));
  console.log("Model State:", JSON.stringify(diag.models, null, 2));
  console.log("Stop Reason:", promptResult?.stopReason ?? promptResult?.error);

  console.log(`\nClassifier Decisions (${diag.classifierDecisions.length}):`);
  for (const d of diag.classifierDecisions) {
    console.log("  ", JSON.stringify(d, null, 2));
  }

  console.log(`\nPermission Requests (${diag.permissionRequests.length}):`);
  for (const p of diag.permissionRequests) {
    console.log("  ", JSON.stringify(p, null, 2));
  }

  console.log(`\nRaw SDK Messages (${diag.sdkMessages.length}):`);
  console.log(`  (see full log at ${logFile})`);

  console.log(`\nResponse Text:`);
  console.log("  " + diag.textChunks.join(""));

  if (diag.errors.length) {
    console.log(`\nErrors:`);
    for (const e of diag.errors) {
      console.log(`  ✗ ${e}`);
    }
  }

  // Write summary to log
  log("SUMMARY", {
    sessionId: diag.sessionId,
    modes: diag.modes,
    models: diag.models,
    promptResult,
    classifierDecisions: diag.classifierDecisions,
    permissionRequestCount: diag.permissionRequests.length,
    sdkMessageCount: diag.sdkMessages.length,
    responseText: diag.textChunks.join(""),
    errors: diag.errors,
  });

  // Step 6: Analyze Claude CLI debug logs
  console.log(`\n── Claude CLI Debug Logs ──`);
  console.log(`  Dir: ${DEBUG_LOGS_DIR}`);
  try {
    const debugFiles = readdirSync(DEBUG_LOGS_DIR);
    console.log(`  Files: ${debugFiles.join(", ") || "(none)"}`);

    for (const file of debugFiles) {
      const filePath = join(DEBUG_LOGS_DIR, file);
      const content = readFileSync(filePath, "utf-8");
      log("DEBUG_LOG_FILE", `${file} (${content.length} bytes)`);

      // Search for classifier-related entries
      const lines = content.split("\n");
      const classifierLines = lines.filter(
        (l) =>
          /classifier|auto.?mode|can_use_tool|permission.*mode|approve|deny|decision/i.test(l),
      );
      if (classifierLines.length) {
        console.log(`\n  Classifier-related entries in ${file}:`);
        for (const l of classifierLines.slice(0, 30)) {
          console.log(`    ${l.slice(0, 200)}`);
          log("CLASSIFIER_LOG", l);
        }
      }

      // Search for HTTP/API entries
      const httpLines = lines.filter(
        (l) => /api\.anthropic|api\.claude|\/v1\/messages|http|request.*id/i.test(l),
      );
      if (httpLines.length) {
        console.log(`\n  HTTP/API entries in ${file} (${httpLines.length} total):`);
        for (const l of httpLines.slice(0, 10)) {
          console.log(`    ${l.slice(0, 200)}`);
        }
        log("HTTP_LOGS", httpLines.slice(0, 50));
      }

      // Search for errors
      const errorLines = lines.filter(
        (l) => /error|fail|unavailable|timeout|分类器/i.test(l),
      );
      if (errorLines.length) {
        console.log(`\n  Errors in ${file}:`);
        for (const l of errorLines.slice(0, 20)) {
          console.log(`    ${l.slice(0, 200)}`);
          log("ERROR_LOG", l);
        }
      }

      // Write full debug log to our log file
      log("FULL_DEBUG_LOG", `--- ${file} ---\n${content.slice(0, 50000)}`);
    }
  } catch (e: any) {
    console.log(`  Could not read debug logs: ${e.message}`);
  }

  console.log(`\n完整日志: ${logFile}`);

  // Cleanup
  try { proc.kill(); } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  try { proc?.kill(); } catch {}
  process.exit(1);
});
