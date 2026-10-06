export type CliErrorCode =
  | "usage"
  | "auth_required"
  | "forbidden"
  | "not_found"
  | "ambiguous_ref"
  | "conflict"
  | "unsupported_capability"
  | "timeout"
  | "network"
  | "server";

const EXIT_CODES: Record<CliErrorCode, number> = {
  usage: 2,
  auth_required: 3,
  forbidden: 4,
  not_found: 5,
  ambiguous_ref: 6,
  conflict: 7,
  unsupported_capability: 8,
  timeout: 9,
  network: 10,
  server: 1,
};

export interface CliErrorOptions {
  exitCode?: number;
  retryable?: boolean;
  status?: number;
  details?: unknown;
  hint?: string;
  cause?: unknown;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: unknown;
  readonly hint?: string;

  constructor(
    readonly code: CliErrorCode,
    message: string,
    options: CliErrorOptions = {},
  ) {
    super(sanitizeCliMessage(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT_CODES[code];
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.details = options.details === undefined ? undefined : sanitizeCliDetails(options.details);
    this.hint = options.hint;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }
}

const SECRET_KEY = /(?:authorization|token|password|secret|api[-_]?key|credential|cookie)/i;
const SECRET_ASSIGNMENT = /\b(authorization|token|password|secret|api[-_]?key|credential|cookie)\s*[:=]\s*([^\s,;]+)/gi;

// Explicit accounting fields, never a general exemption for keys containing "token".
const USAGE_COUNTER_FIELDS = new Set([
  "actual_input_tokens", "actual_output_tokens", "actual_cache_read_tokens", "actual_cache_write_tokens",
  "actual_unsplit_tokens", "actual_total_tokens", "priced_tokens", "unpriced_tokens",
  "context_peak_tokens", "task_attributed_tokens",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens",
  "actualUnsplitTokens", "reportedTotalTokens", "contextTokens", "contextWindow",
]);

export function isPublicUsageStatistic(key: string, value: unknown): boolean {
  if (key === "token_ratio") return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
  return USAGE_COUNTER_FIELDS.has(key) && (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
}

export function sanitizeCliMessage(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer ***")
    .replace(SECRET_ASSIGNMENT, "$1=***");
}

export function sanitizeCliDetails(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value.replace(/\bBearer\s+\S+/gi, "Bearer ***");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeCliDetails(entry, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) && !isPublicUsageStatistic(key, entry) ? "***" : sanitizeCliDetails(entry, seen);
  }
  return output;
}

export function cliErrorCodeForStatus(status: number): CliErrorCode {
  if (status === 401) return "auth_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  return "server";
}
