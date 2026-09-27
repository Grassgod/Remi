/**
 * Keep database credentials out of log lines and thrown messages.
 *
 * The pool and the backfill both log text that comes from the driver or from
 * the database (`onclose` errors, a failed batch, a refused statement). Bun's
 * own messages for a dropped connection are generic — "Connection closed" — but
 * that is a property of the current driver version, not a contract, and the
 * same helpers also run over errors raised far below them. A DSN that reaches a
 * log line is a credential leak, so the text is scrubbed on the way out rather
 * than trusted to be clean.
 *
 * The pattern matches a scheme with userinfo (`postgres://user:secret@host`).
 * A DSN without userinfo has nothing to hide and is left readable, which keeps
 * the message useful for "which host did this" debugging.
 */

/**
 * `scheme://user:password@host` → `scheme://***@host`.
 *
 * The userinfo runs to the LAST `@` that still precedes the host, because
 * libpq accepts an unencoded `@` inside a password. A greedy `[^\s/?#]*@`
 * therefore consumes `svc:pa@ss@` as one userinfo rather than stopping at the
 * first `@` and leaving `ss@` in the output. The host that follows is the last
 * `@`-delimited segment, which is what a DSN's authority actually is.
 */
const USERINFO_DSN_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/giu;

/**
 * Secret-shaped key/value fragments that sometimes ride along in a driver
 * message, e.g. `password=…`, `sslpassword: …` or `MULTIREMI_TOKEN=…`. The
 * `sslpassword` form is listed rather than matched by a `password` substring,
 * so a name like `password_hint` is not mistaken for a credential while
 * libpq's own key still is.
 *
 * The leading boundary excludes only letters and digits, so `_` counts as one.
 * `\b` would not fire there — an env-var-style name like `MULTIREMI_TOKEN` has
 * no word boundary before `TOKEN` — and underscore-prefixed names are exactly
 * the shape a leaked env var arrives in.
 */
const KEYED_SECRET_RE =
  /(^|[^A-Za-z0-9])(sslpassword|password|passwd|pwd|secret|token|apikey|api_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gimu;

/**
 * Replace any credentials in `text` with `***`.
 *
 * Safe to call on non-URL text: a message with neither a DSN nor a
 * secret-shaped key/value pair passes through unchanged.
 */
export function scrubCredentials(text: string): string {
  return text
    .replace(USERINFO_DSN_RE, (_match, scheme: string) => `${scheme}***@`)
    // Every captured piece is re-emitted verbatim; only the value is dropped,
    // so the message keeps its original punctuation and separators.
    .replace(
      KEYED_SECRET_RE,
      (_match, before: string, key: string, separator: string) => `${before}${key}${separator}***`,
    );
}

/**
 * Scrub an unknown thrown value for logging. Returns only the message; the
 * stack is deliberately not included, since it is longer and no more useful in
 * a warn line.
 */
export function scrubErrorForLog(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubCredentials(message);
}
