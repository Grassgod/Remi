/**
 * Lightweight structured logger with level filtering.
 *
 * Usage:
 *   import { createLogger, setLogLevel } from "./logger.js";
 *   setLogLevel("DEBUG");                    // call once at startup
 *   const log = createLogger("core");        // per-module
 *   log.info("started");                     // [12:34:56] INFO  [core] started
 *   log.debug("delta", { len: 42 });         // filtered out at INFO level
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let globalLevel: LogLevel = "INFO";

export function setLogLevel(level: string): void {
  const upper = level.toUpperCase() as LogLevel;
  if (upper in LEVELS) {
    globalLevel = upper;
  }
}

export function getLogLevel(): LogLevel {
  return globalLevel;
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

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
  const prefix = `[${module}]`;

  function emit(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVELS[level] < LEVELS[globalLevel]) return;
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
  }

  return {
    debug: (msg, ...args) => emit("DEBUG", msg, args),
    info: (msg, ...args) => emit("INFO", msg, args),
    warn: (msg, ...args) => emit("WARN", msg, args),
    error: (msg, ...args) => emit("ERROR", msg, args),
  };
}
