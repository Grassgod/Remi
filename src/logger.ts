/**
 * Structured logger with level filtering, console output, and JSONL persistence.
 *
 * Usage:
 *   import { createLogger, setLogLevel, initLogPersistence } from "./logger.js";
 *   setLogLevel("DEBUG");                    // call once at startup
 *   initLogPersistence();                    // enable file persistence
 *   const log = createLogger("core");        // per-module
 *   log.info("started");                     // [12:34:56] INFO  [core] started
 *   log.debug("delta", { len: 42 });         // filtered out at INFO level
 *   const child = log.child({ traceId: "abc" }); // trace-correlated logger
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let globalLevel: LogLevel = "INFO";

// Persistence state
let _logsDir: string | null = null;
let _buffer: string[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 1000; // 1 second
const FLUSH_SIZE = 64;       // flush after N entries

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase() as LogLevel;
  if (upper in LEVELS) {
    globalLevel = upper;
  }
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

/** Initialize log file persistence. Call once at startup. */
export function initLogPersistence(dir?: string): void {
  _logsDir = dir ?? join(homedir(), ".remi", "logs");
  mkdirSync(_logsDir, { recursive: true });
}

/** Structured log entry persisted to JSONL. */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  traceId?: string;
  spanId?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /** Create a child logger that attaches trace context to every entry. */
  child(extra: { traceId?: string; spanId?: string }): Logger;
}

function ts(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function dateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function flushBuffer(): void {
  if (!_logsDir || _buffer.length === 0) return;
  // Group by date (almost always same date, but handle midnight edge case)
  const byDate = new Map<string, string[]>();
  for (const line of _buffer) {
    const date = line.slice(7, 17); // extract date from ISO ts: {"ts":"YYYY-MM-DD...
    const arr = byDate.get(date);
    if (arr) arr.push(line);
    else byDate.set(date, [line]);
  }
  for (const [date, lines] of byDate) {
    const filePath = join(_logsDir!, `${date}.jsonl`);
    appendFileSync(filePath, lines.join("\n") + "\n");
  }
  _buffer = [];
  _flushTimer = null;
}

function scheduleFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL);
}

function persistEntry(entry: LogEntry): void {
  if (!_logsDir) return;
  _buffer.push(JSON.stringify(entry));
  if (_buffer.length >= FLUSH_SIZE) {
    flushBuffer();
  } else {
    scheduleFlush();
  }
}

/** Flush any pending log entries to disk. Call before shutdown. */
export function flushLogs(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  flushBuffer();
}

export function createLogger(
  module: string,
  traceCtx?: { traceId?: string; spanId?: string },
): Logger {
  const prefix = `[${module}]`;

  function emit(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVELS[level] < LEVELS[globalLevel]) return;

    // Console output: human-readable
    const tag = `[${ts()}] ${level.padEnd(5)} ${prefix} ${msg}`;
    switch (level) {
      case "ERROR":
        console.error(tag, ...args);
        break;
      case "WARN":
        console.warn(tag, ...args);
        break;
      default:
        console.log(tag, ...args);
        break;
    }

    // Build structured entry for persistence
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      module,
      msg,
    };
    if (traceCtx?.traceId) entry.traceId = traceCtx.traceId;
    if (traceCtx?.spanId) entry.spanId = traceCtx.spanId;

    // Extract structured data from args
    if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
      entry.data = args[0] as Record<string, unknown>;
    } else if (args.length > 0) {
      entry.data = { _args: args.map((a) => (a instanceof Error ? a.message : String(a))) };
    }

    persistEntry(entry);
  }

  const logger: Logger = {
    debug: (msg, ...args) => emit("DEBUG", msg, args),
    info: (msg, ...args) => emit("INFO", msg, args),
    warn: (msg, ...args) => emit("WARN", msg, args),
    error: (msg, ...args) => emit("ERROR", msg, args),
    child(extra) {
      return createLogger(module, {
        traceId: extra.traceId ?? traceCtx?.traceId,
        spanId: extra.spanId ?? traceCtx?.spanId,
      });
    },
  };

  return logger;
}

// ── Read & Cleanup utilities ──────────────────────────────────────

/** Read log entries for a given date from JSONL files. */
export function readLogEntries(date: string, logsDir?: string): LogEntry[] {
  const dir = logsDir ?? _logsDir ?? join(homedir(), ".remi", "logs");
  const filePath = join(dir, `${date}.jsonl`);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const entries: LogEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** Delete JSONL log files older than retentionDays. Returns count of removed files. */
export function cleanupOldLogs(logsDir: string, retentionDays: number): number {
  if (!existsSync(logsDir)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let removed = 0;
  for (const file of readdirSync(logsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const dateStr = file.replace(".jsonl", "");
    if (dateStr < cutoffStr) {
      unlinkSync(join(logsDir, file));
      removed++;
    }
  }
  return removed;
}
