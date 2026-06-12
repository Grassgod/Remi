/**
 * Minimal structured logger for the Bun rewrite. Mirrors the createLogger
 * surface the ported ACP layer expects (per-module debug/info/warn/error).
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let threshold: LogLevel = ((): LogLevel => {
  const env = process.env.LOG_LEVEL?.toUpperCase();
  return env && env in ORDER ? (env as LogLevel) : "INFO";
})();

export function setLogLevel(level: string): void {
  const up = level.toUpperCase();
  if (up in ORDER) threshold = up as LogLevel;
}

export function createLogger(name: string): Logger {
  const emit = (level: LogLevel, args: unknown[]): void => {
    if (ORDER[level] < ORDER[threshold]) return;
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] ${level.padEnd(5)} [${name}]`, ...args);
  };
  return {
    debug: (...args) => emit("DEBUG", args),
    info: (...args) => emit("INFO", args),
    warn: (...args) => emit("WARN", args),
    error: (...args) => emit("ERROR", args),
  };
}
