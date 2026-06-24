export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  child(meta: Record<string, unknown>): Logger;
}

export function createLogger(name: string, meta?: Record<string, unknown>): Logger {
  const prefix = meta
    ? `[${name}] ${Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(" ")} `
    : `[${name}] `;

  const logger: Logger = {
    info: (msg, ...args) => console.log(`${prefix}${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`${prefix}${msg}`, ...args),
    error: (msg, ...args) => console.error(`${prefix}${msg}`, ...args),
    debug: (msg, ...args) => {
      if (process.env.DEBUG) console.debug(`${prefix}${msg}`, ...args);
    },
    child: (childMeta) => createLogger(name, { ...meta, ...childMeta }),
  };
  return logger;
}
