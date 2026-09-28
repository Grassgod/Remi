import { Buffer } from "node:buffer";

/** AIR metadata shared by the pinned Claude and Codex ACP bridges. */
export interface AcpSessionFailure {
  id: string;
  revision: number;
  category: string;
  severity: "error" | "warning";
  title: string;
  details?: string;
  errorKind?: string;
  codexErrorInfo?: unknown;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function airMetadata(meta: unknown): Record<string, unknown> | null {
  return record(record(record(meta)?.jetbrains)?.air);
}

export function readSessionFailure(meta: unknown, credentials: readonly string[] = []): AcpSessionFailure | null {
  const failure = record(airMetadata(meta)?.sessionFailure);
  if (!failure || typeof failure.id !== "string" || typeof failure.revision !== "number"
    || typeof failure.category !== "string" || typeof failure.title !== "string"
    || (failure.severity !== "error" && failure.severity !== "warning")) return null;
  return redactSessionFailure({
    id: failure.id, revision: failure.revision, category: failure.category,
    severity: failure.severity, title: failure.title,
    ...(typeof failure.details === "string" ? { details: failure.details } : {}),
    ...(typeof failure.errorKind === "string" ? { errorKind: failure.errorKind } : {}),
    ...(failure.codexErrorInfo != null ? { codexErrorInfo: failure.codexErrorInfo } : {}),
  }, credentials);
}

/** Shared ACP/daemon boundary; callers can also supply their injected secrets. */
export function redactProviderErrorText(text: string, credentials: readonly string[] = []): string {
  const values = new Set<string>();
  for (const credential of credentials) {
    for (const value of new Set([credential, credential.trim()])) {
      if (!value) continue;
      values.add(value);
      values.add(Buffer.from(value).toString("base64"));
      values.add(Buffer.from(value).toString("base64url"));
      try {
        const encoded = encodeURIComponent(value);
        values.add(encoded);
        values.add(encoded.replace(/%20/g, "+"));
        values.add(encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()));
      } catch { /* Malformed Unicode still has raw and Base64 representations. */ }
    }
  }
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    text = text.split(value).join("[REDACTED]");
  }
  // Decode credential names only, leaving URLs and diagnostic text intact.
  text = text.replace(/(?:[a-z0-9_-]|%[0-9a-f]{2})+(?=["']?\s*[:=])/gi, (key) => {
    let decoded = key;
    try { decoded = decodeURIComponent(key); } catch { /* Leave malformed names alone. */ }
    return /^(?:api[_-]?key|auth[_-]?token|access[_-]?token|key|token|password|secret|session|sid|sessionid)$/i.test(decoded)
      ? decoded : key;
  });
  return text
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b["']?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n"'`}]+)/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s"'`,;&}]+/gi, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\bsk-[a-z0-9_-]+/gi, "[REDACTED]")
    .replace(/\b(?:ghp|gho)_[a-z0-9]{4,}\b/gi, "[REDACTED]")
    .replace(/(?<![/:.@])\b[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}\b/gi, "[REDACTED]")
    .replace(/(\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|key|token|password|secret|session|sid|sessionid)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'`,;&}]+)/gi, "$1[REDACTED]");
}

function redactSessionFailure(failure: AcpSessionFailure, credentials: readonly string[]): AcpSessionFailure {
  const safe: AcpSessionFailure = {
    id: failure.id, revision: failure.revision, category: failure.category,
    severity: failure.severity, title: failure.title,
    ...(failure.details != null ? { details: failure.details } : {}),
    ...(failure.errorKind != null ? { errorKind: failure.errorKind } : {}),
    ...(failure.codexErrorInfo != null ? { codexErrorInfo: failure.codexErrorInfo } : {}),
  };
  for (const key of ["id", "category", "title", "details", "errorKind"] as const) {
    if (typeof safe[key] === "string") safe[key] = redactProviderErrorText(safe[key], credentials);
  }
  if (safe.codexErrorInfo != null) {
    // Wire diagnostics are JSON. Redact string values without changing status codes.
    try {
      safe.codexErrorInfo = JSON.parse(JSON.stringify(safe.codexErrorInfo, (_key, value) =>
        typeof value === "string" ? redactProviderErrorText(value, credentials) : value));
    } catch { delete safe.codexErrorInfo; }
  }
  return safe;
}

export function redactProviderError(caught: unknown, credentials: readonly string[] = []): Error {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  const safe = error instanceof AcpRpcError
    ? new AcpRpcError(error.code, "", error.data, credentials)
    : error instanceof AcpSessionFailureError
      ? new AcpSessionFailureError(error.failure, undefined, credentials)
      : new Error(redactProviderErrorText(error.message, credentials));
  safe.message = redactProviderErrorText(error.message, credentials);
  safe.name = redactProviderErrorText(error.name, credentials);
  if (error instanceof AcpSessionFailureError) {
    Object.defineProperty(safe, "hint", { value: error.hint, enumerable: false });
  }
  if (error.stack) safe.stack = redactProviderErrorText(error.stack, credentials);
  return safe;
}

function rpcDetail(data: unknown, credentials: readonly string[]): string {
  if (typeof data === "string") return redactProviderErrorText(data, credentials).slice(0, 500);
  const source = record(data);
  if (!source) return "";
  const allowed: Record<string, string> = {};
  for (const key of ["errorKind", "message", "details"]) {
    if (typeof source[key] === "string") allowed[key] = redactProviderErrorText(source[key], credentials);
  }
  return Object.keys(allowed).length ? JSON.stringify(allowed).slice(0, 500) : "";
}

export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown, credentials: readonly string[] = []) {
    const detail = rpcDetail(data, credentials);
    super(`RPC error ${code}: ${redactProviderErrorText(message, credentials)}${detail ? `: ${detail}` : ""}`);
    this.name = "AcpRpcError";
    // Keep structured hints for classification, out of JSON/log serialization.
    Object.defineProperty(this, "data", { value: data, enumerable: false });
  }
}

export class AcpSessionFailureError extends Error {
  readonly failure: AcpSessionFailure;
  readonly hint: { category: string; errorKind?: string; codexErrorInfo?: unknown };

  constructor(failure: AcpSessionFailure, cause?: Error, credentials: readonly string[] = []) {
    const safe = redactSessionFailure(failure, credentials);
    super([safe.title, safe.details].filter(Boolean).join(": "), { cause: cause ? redactProviderError(cause, credentials) : undefined });
    this.name = "AcpSessionFailureError";
    this.failure = safe;
    const data = cause instanceof AcpRpcError ? record(cause.data) : null;
    this.hint = {
      category: failure.category,
      errorKind: failure.errorKind ?? (typeof data?.errorKind === "string" ? data.errorKind : undefined),
      codexErrorInfo: failure.codexErrorInfo ?? data?.codexErrorInfo,
    };
    Object.defineProperty(this, "hint", { enumerable: false });
  }
}
