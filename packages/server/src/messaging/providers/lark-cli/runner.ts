import {
  MessageProviderError,
  type MessageErrorCode,
} from "@multiremi/contracts/messaging.js";
import { createLogger } from "@shared/logger.js";

export type LarkCliCommandKind = "read" | "send";

export interface LarkCliRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  kind?: LarkCliCommandKind;
  /**
   * Return trimmed stdout instead of requiring JSON.
   *
   * Only `lark-cli --version` needs this: it predates the `--format` flag and
   * rejects it, so its single `lark-cli version X.Y.Z` line is the only
   * machine-readable version source. Every other command must stay on JSON.
   */
  text?: boolean;
}

/** Process boundary used by the Provider. Tests inject a fake implementation. */
export interface LarkCliRunner {
  run(argv: readonly string[], options?: LarkCliRunOptions): Promise<unknown>;
}

export interface BunLarkCliRunnerOptions {
  executable?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

interface CapturedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 250;
const log = createLogger("lark-cli-message-provider");

/** Runs lark-cli directly with argv. No shell is involved. */
export class BunLarkCliRunner implements LarkCliRunner {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string | undefined>;

  constructor(options: BunLarkCliRunnerOptions = {}) {
    this.executable = options.executable ?? "lark-cli";
    this.timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    // lark-cli renders message timestamps as a bare `YYYY-MM-DD HH:MM` in its
    // own local zone, with no flag to ask for UTC or an epoch. The same message
    // therefore reads `2026-09-01 00:51` on a +08:00 host and `2026-08-31 16:51`
    // on a UTC one. Pinning TZ is what makes that field mean one instant, so it
    // is forced rather than merely defaulted: an inherited TZ would silently
    // shift every ingested timestamp by the host's offset.
    this.env = { ...(options.env ?? process.env), TZ: "UTC" };
  }

  async run(argv: readonly string[], options: LarkCliRunOptions = {}): Promise<unknown> {
    if (argv.length === 0 || argv.some((entry) => typeof entry !== "string")) {
      throw new MessageProviderError("unknown", "lark-cli argv must be a non-empty string array");
    }

    const kind = options.kind ?? "read";
    let processHandle: ReturnType<typeof Bun.spawn>;
    try {
      processHandle = Bun.spawn([this.executable, ...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: this.env,
      });
    } catch (cause) {
      log.warn("lark-cli executable is unavailable; install lark-cli before enabling this connection");
      throw new MessageProviderError("provider_unavailable", "lark-cli is not installed", { cause });
    }

    const timeoutMs = positiveInteger(options.timeoutMs) ?? this.timeoutMs;
    const captured = await captureProcess(processHandle, options.signal, timeoutMs);
    const parsedStdout = parseStructuredOutput(captured.stdout);
    const parsedStderr = parseStructuredOutput(captured.stderr);
    const parsed = parsedStdout ?? parsedStderr;

    if (captured.exitCode !== 0) {
      const structuredError = structuredErrorDetails(parsedStdout) ?? structuredErrorDetails(parsedStderr);
      const code = structuredError
        ? mapLarkCliErrorCode(structuredError.code, kind)
        : mapExitCode(captured.exitCode, kind);
      if (code === "capability_unsupported") {
        log.warn("lark-cli required command is unavailable; install a compatible lark-cli release");
      }
      throw new MessageProviderError(code, safeFailureMessage(code, captured.exitCode), {
        retryAfterMs: structuredError?.retryAfterMs,
      });
    }

    if (options.text) return captured.stdout.trim();

    if (parsed === null) {
      const code = kind === "send" ? "send_result_unknown" : "malformed_response";
      log.warn("lark-cli returned no structured JSON; structured output support is required");
      throw new MessageProviderError(code, safeFailureMessage(code, captured.exitCode));
    }

    const structuredError = structuredErrorDetails(parsed);
    if (structuredError) {
      const code = mapLarkCliErrorCode(structuredError.code, kind);
      if (code === "capability_unsupported") {
        log.warn("lark-cli required command is unavailable; install a compatible lark-cli release");
      }
      throw new MessageProviderError(code, safeFailureMessage(code, captured.exitCode), {
        retryAfterMs: structuredError.retryAfterMs,
      });
    }
    return parsed;
  }
}

export function mapLarkCliErrorCode(value: unknown, kind: LarkCliCommandKind = "read"): MessageErrorCode {
  const code = stringValue(value).toLowerCase().replace(/[\s.-]+/gu, "_");
  if (["provider_unavailable", "command_not_found", "enoent", "not_installed"].includes(code)) {
    return "provider_unavailable";
  }
  if (["provider_incompatible", "incompatible_version", "version_unsupported"].includes(code)) {
    return "provider_incompatible";
  }
  if (["capability_unsupported", "unknown_command", "command_unsupported", "not_supported"].includes(code)) {
    return "capability_unsupported";
  }
  if ([
    "unauthenticated",
    "unauthorized",
    "auth_required",
    "not_logged_in",
    "token_expired",
    "credential_expired",
    "needs_refresh",
    "401",
  ].includes(code)) {
    return "unauthenticated";
  }
  // `missing_scope` and `confirmation_required` are lark-cli subtypes: the first
  // is an un-granted OAuth scope, the second a high-risk write withheld pending
  // `--yes`. Neither is retryable and both need an operator, so both are forbidden.
  if ([
    "forbidden",
    "permission_denied",
    "scope_missing",
    "missing_scope",
    "confirmation_required",
    "authorization",
    "403",
  ].includes(code)) {
    return "forbidden";
  }
  // `quota_exceeded` is lark-cli's throttling subtype; it must stay retryable or
  // ingestion stalls permanently the first time a poll trips a quota.
  if (["rate_limited", "too_many_requests", "throttled", "quota_exceeded", "429"].includes(code)) {
    return "rate_limited";
  }
  if (["timeout", "timed_out", "deadline_exceeded", "124"].includes(code)) return "timeout";
  if (["unreachable", "network", "network_error", "connection_failed", "connection_refused"].includes(code)) {
    return "unreachable";
  }
  if (["malformed_response", "invalid_json", "invalid_response"].includes(code)) return "malformed_response";
  if (["not_found", "resource_not_found", "404"].includes(code)) return "not_found";
  if (["send_result_unknown", "send_unknown", "indeterminate_send"].includes(code)) return "send_result_unknown";
  return kind === "send" ? "send_result_unknown" : "unknown";
}

async function captureProcess(
  processHandle: ReturnType<typeof Bun.spawn>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<CapturedProcess> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: MessageProviderError) => void) | undefined;
  let aborted = false;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    killProcess(processHandle);
    rejectAbort?.(new MessageProviderError("timeout", "lark-cli command was aborted"));
  };
  const timeout = (): void => {
    if (aborted) return;
    aborted = true;
    killProcess(processHandle);
    rejectAbort?.(new MessageProviderError("timeout", "lark-cli command timed out"));
  };

  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  if (!aborted) timer = setTimeout(timeout, timeoutMs);

  const capturePromise = Promise.all([
    processHandle.exited,
    readProcessStream(processHandle.stdout),
    readProcessStream(processHandle.stderr),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));

  try {
    return await Promise.race([capturePromise, abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (aborted) {
      await Promise.race([
        processHandle.exited.catch(() => undefined),
        Bun.sleep(TERMINATION_GRACE_MS),
      ]);
      if (processHandle.exitCode === null) {
        killProcess(processHandle, "SIGKILL");
        await Promise.race([
          processHandle.exited.catch(() => undefined),
          Bun.sleep(TERMINATION_GRACE_MS),
        ]);
      }
    }
  }
}

function killProcess(processHandle: ReturnType<typeof Bun.spawn>, signal?: NodeJS.Signals): void {
  try {
    processHandle.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

function readProcessStream(value: unknown): Promise<string> {
  return value instanceof ReadableStream ? new Response(value).text() : Promise.resolve("");
}

function parseStructuredOutput(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function structuredErrorDetails(value: unknown): { code: unknown; retryAfterMs: number | null } | null {
  const root = record(value);
  if (!root) return null;
  if (root.ok !== false && root.success !== false && root.error === undefined) return null;
  const error = record(root.error) ?? record(record(root.data)?.error) ?? root;

  // lark-cli reports `{type, subtype, code}` where `subtype` carries the meaning
  // and `code` — when present at all — is a numeric Feishu OpenAPI code, not an
  // error name. Reading `code` first (as an earlier revision did) turned every
  // API failure into the string "230001" and so into `unknown`, which silently
  // disabled both auth reporting and the rate-limit retry. Prefer the names.
  const subtype = stringValue(error.subtype);
  const named = subtype && subtype !== "unknown"
    ? subtype
    : stringValue(error.error_code) || stringValue(error.type);

  // An unknown subcommand is `validation/invalid_argument`, indistinguishable
  // from a bad flag by code alone, so the missing-command case is recognised by
  // the parameter lark-cli rejected.
  if (named === "invalid_argument" && mentionsUnknownCommand(error)) {
    return { code: "capability_unsupported", retryAfterMs: null };
  }

  const code = named || error.code;
  if (code === undefined || code === null || stringValue(code) === "") return null;
  return {
    code,
    retryAfterMs: nonNegativeInteger(error.retry_after_ms ?? error.retryAfterMs),
  };
}

/** True when lark-cli rejected the command name itself rather than a flag value. */
function mentionsUnknownCommand(error: Record<string, unknown>): boolean {
  const reasons = Array.isArray(error.params)
    ? error.params.map((entry) => stringValue(record(entry)?.reason).toLowerCase())
    : [];
  if (reasons.some((reason) => reason.includes("unknown subcommand") || reason.includes("unknown command"))) {
    return true;
  }
  const message = stringValue(error.message).toLowerCase();
  return message.startsWith("unknown subcommand") || message.startsWith("unknown command");
}

function mapExitCode(exitCode: number, kind: LarkCliCommandKind): MessageErrorCode {
  if (exitCode === 127) return "provider_unavailable";
  if (exitCode === 124) return "timeout";
  return kind === "send" ? "send_result_unknown" : "unknown";
}

function safeFailureMessage(code: MessageErrorCode, exitCode: number): string {
  return `lark-cli command failed (${code}, exit ${exitCode})`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
