/**
 * Client-side fallback for redacting sensitive information in agent output.
 * The server performs primary redaction; this is a safety net for display.
 */

const patterns: { re: RegExp; replacement: string }[] = [
  // AWS access key IDs
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED AWS KEY]" },
  // AWS secret access keys
  { re: /(?:aws_secret_access_key|secret_?access_?key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi, replacement: "[REDACTED AWS SECRET]" },
  // PEM private keys
  { re: /-----BEGIN[A-Z\s]*PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]*PRIVATE KEY-----/g, replacement: "[REDACTED PRIVATE KEY]" },
  // GitHub tokens
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g, replacement: "[REDACTED GITHUB TOKEN]" },
  // GitLab personal access tokens
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED GITLAB TOKEN]" },
  // OpenAI / Anthropic API keys
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED API KEY]" },
  // Slack tokens
  { re: /\bxox[bporas]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED SLACK TOKEN]" },
  // JWT tokens
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED JWT]" },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  // Connection strings with embedded passwords
  { re: /(?:postgres|mysql|mongodb|redis|amqp)(?:ql)?:\/\/[^:\s]+:[^@\s]+@/gi, replacement: "[REDACTED CONNECTION STRING]@" },
  // Generic key=value secret env vars
  { re: /(?:API_KEY|API_SECRET|SECRET_KEY|SECRET|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|DATABASE_URL|DB_PASSWORD|DB_URL|REDIS_URL|PASSWORD|TOKEN)\s*[=:]\s*\S+/gi, replacement: "[REDACTED CREDENTIAL]" },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { re, replacement } of patterns) {
    result = result.replace(re, replacement);
  }
  return result;
}

// Key names whose value is a secret regardless of the value's own shape — the
// string patterns above only fire on `KEY=value` / `KEY: value` text, so a
// structured `{ "api_key": "raw" }` (tool input, meta) would slip through.
const SENSITIVE_KEY_RE =
  /(api[_-]?key|secret|token|password|passwd|credential|auth|private[_-]?key|access[_-]?key|database[_-]?url|conn(ection)?[_-]?string)/i;

// Home-directory prefixes → placeholder, so absolute paths in tool inputs /
// diffs / file locations don't leak the OS username in screen shares.
const HOME_PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^/\\\s"']+/g;

function privatizeHomePaths(text: string): string {
  return text.replace(HOME_PATH_RE, (match) => {
    const sep = match.includes("\\") ? "\\" : "/";
    const root = match.startsWith("/home") ? "/home" : match.includes(":\\") ? match.slice(0, 3) + "Users" : "/Users";
    return `${root}${sep}<user>`;
  });
}

/** String redaction + home-path privatization, applied to any leaf string. */
export function redactString(text: string): string {
  return privatizeHomePaths(redactSecrets(text));
}

/**
 * Recursively redact an arbitrary value (tool input, meta, diff blocks) for
 * display or copy. Masks values under sensitive key names outright, runs every
 * leaf string through redactString, and is depth/cycle safe. The string
 * `redactSecrets` alone can't cover structured `{ "token": "raw" }` shapes.
 */
export function redactValue<T>(value: T, _depth = 0, _seen = new WeakSet<object>()): T {
  if (_depth > 8) return "[REDACTED DEPTH]" as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (_seen.has(value)) return "[REDACTED CYCLE]" as unknown as T;
  _seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, _depth + 1, _seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY_RE.test(k) && typeof v === "string" ? "[REDACTED CREDENTIAL]" : redactValue(v, _depth + 1, _seen);
  }
  return out as unknown as T;
}

const REDACTED_ITEM_STRINGS = [
  "text", "output", "command", "cwd", "prompt", "title", "summary", "query", "url", "description", "message", "error",
] as const;

/**
 * A trace item ready for display or copy: every free-text field through
 * {@link redactString}, structured payloads (tool input, questions, answers,
 * parsed command actions, diffs) through {@link redactValue}. Ids, statuses and
 * timestamps are left alone so rows keep their identity. The result is cached
 * per item object.
 */
const REDACTED_ITEMS = new WeakMap<object, object>();

export function redactItem<T extends object>(item: T): T {
  const cached = REDACTED_ITEMS.get(item);
  if (cached) return cached as T;
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of REDACTED_ITEM_STRINGS) {
    const value = out[key];
    if (typeof value === "string") out[key] = redactString(value);
  }
  for (const key of ["input", "questions", "answers", "actions", "changes", "entries"]) {
    if (out[key] !== null && typeof out[key] === "object") out[key] = redactValue(out[key]);
  }
  // Items are immutable (the reducer replaces what changes), so the result is
  // reusable for as long as the item lives.
  REDACTED_ITEMS.set(item, out);
  return out as unknown as T;
}
