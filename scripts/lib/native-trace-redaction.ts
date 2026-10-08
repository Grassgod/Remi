import type { TraceEvent } from "../../packages/contracts/src/trace.js";

const MARKER = "[credential redacted during historical recovery]";
const SECRET_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|(?:x-)?api[-_]?key|password|access_token|refresh_token|tenant_access_token|user_access_token|client_secret|.*_(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|SECRET_KEY))$/i;
const TOKEN_PATTERNS = [
  /\b(?:mul|mdt)_[a-f0-9]{64}\b/g,
  /\bmat_[a-f0-9]{40}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

/** Recovered tool output can contain credentials that never belonged in a transcript. */
export function redactNativeTrace(events: readonly TraceEvent[]): { events: TraceEvent[]; redactions: number; changedEvents: number } {
  let total = 0, changedEvents = 0;
  const clean = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map(v => clean(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    if (typeof value !== "string" || value === MARKER) return value;
    if (SECRET_FIELD.test(key) && value.length >= 16 && !/^(?:\$|<|\[|process\.env\.)/.test(value)) { total++; return MARKER; }
    let text = value;
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, () => { total++; return MARKER; });
    text = text.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, (_all, prefix) => { total++; return prefix + MARKER; });
    text = text.replace(/(["']?[\w.-]*(?:token|secret|password|api[_-]?key|access[_-]?key|secret[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi,
      (_all, prefix) => { total++; return prefix + MARKER; });
    return text;
  };
  const output = events.map(event => {
    const before = total;
    const result = clean(event) as TraceEvent;
    if (total > before) { changedEvents++; result.meta = { ...result.meta, recovery_redactions: total - before }; }
    return result;
  });
  return { events: output, redactions: total, changedEvents };
}
