/**
 * Validate a post-login redirect URL and return it only if safe to follow.
 *
 * Only single-slash relative paths (e.g. `/invite/abc`) are accepted. Returns
 * `null` for unsafe or empty input — call sites decide the fallback so this
 * helper never overloads a specific path with "user did not pass next".
 *
 * Rejects:
 *   - `null` / empty string
 *   - absolute URLs (`https://evil.com`, `javascript:alert(1)`, …)
 *   - protocol-relative URLs (`//evil.com`)
 *   - paths containing backslashes (Windows-style or `/\\host`)
 *   - paths containing ASCII control characters (`\x00`–`\x1f`)
 */
export function sanitizeNextUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex -- intentional: rejecting control chars is the whole point
  if (/[\x00-\x1f\\]/.test(raw)) return null;
  return raw;
}

/**
 * Return an email suitable for display, or `null` to hide it. Synthetic
 * placeholder addresses on a `.local` domain (e.g. `<openId>@feishu.local`
 * minted when an SSO provider returns no real email, or `<id>@multica.local`)
 * are not real inboxes, so callers hide them and show just the name.
 */
export function displayableEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().endsWith(".local")) return null;
  return trimmed;
}
