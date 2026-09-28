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

export function readSessionFailure(meta: unknown): AcpSessionFailure | null {
  const failure = record(airMetadata(meta)?.sessionFailure);
  if (!failure || typeof failure.id !== "string" || typeof failure.revision !== "number"
    || typeof failure.category !== "string" || typeof failure.title !== "string"
    || (failure.severity !== "error" && failure.severity !== "warning")) return null;
  return {
    id: failure.id, revision: failure.revision, category: failure.category,
    severity: failure.severity, title: failure.title,
    ...(typeof failure.details === "string" ? { details: failure.details } : {}),
    ...(typeof failure.errorKind === "string" ? { errorKind: failure.errorKind } : {}),
    ...(failure.codexErrorInfo != null ? { codexErrorInfo: failure.codexErrorInfo } : {}),
  };
}

export class AcpRpcError extends Error {
  constructor(code: number, message: string, readonly data?: unknown) {
    const detail = data == null ? "" : (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 500);
    super(`RPC error ${code}: ${message}${detail ? `: ${detail}` : ""}`);
    this.name = "AcpRpcError";
  }
}

export class AcpSessionFailureError extends Error {
  readonly hint: { category: string; errorKind?: string; codexErrorInfo?: unknown };

  constructor(readonly failure: AcpSessionFailure, cause?: Error) {
    super([failure.title, failure.details].filter(Boolean).join(": "), { cause });
    this.name = "AcpSessionFailureError";
    const data = cause instanceof AcpRpcError ? record(cause.data) : null;
    this.hint = {
      category: failure.category,
      errorKind: failure.errorKind ?? (typeof data?.errorKind === "string" ? data.errorKind : undefined),
      codexErrorInfo: failure.codexErrorInfo ?? data?.codexErrorInfo,
    };
  }
}
