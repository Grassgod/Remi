// Reading and validating the incoming request: JSON body parsers (lenient, strict and
// strict-allow-empty), query-string coercion, and remote-address extraction.

export function queryInt(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function boundedQueryInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = queryInt(value, fallback);
  if (parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return await c.req.json() as T;
  } catch {
    return {} as T;
  }
}

export async function readJsonStrict<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | { apiError: string; statusCode: 400 }> {
  try {
    return await c.req.json() as T;
  } catch {
    return { apiError: "invalid request body", statusCode: 400 };
  }
}

export function isJsonApiError(value: unknown): value is { apiError: string; statusCode: 400 } {
  return typeof value === "object" && value !== null && "apiError" in value && "statusCode" in value;
}

export async function readJsonStrictAllowEmpty<T>(c: {
  req: {
    json: () => Promise<unknown>;
    header?: (name: string) => string | undefined;
  };
}): Promise<T | { apiError: string; statusCode: 400 }> {
  const contentLength = c.req.header?.("content-length");
  const contentType = c.req.header?.("content-type");
  if ((contentLength == null || contentLength === "0") && !contentType) return {} as T;
  return readJsonStrict<T>(c);
}

export function requestRemoteAddress(request: Request): string {
  const candidate = request as Request & {
    ip?: unknown;
    remoteAddress?: unknown;
    remoteAddr?: unknown;
    socket?: { remoteAddress?: unknown };
  };
  for (const value of [candidate.remoteAddress, candidate.remoteAddr, candidate.ip, candidate.socket?.remoteAddress]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function remoteAddrHost(remote: string): string {
  if (!remote) return "";
  if (remote.startsWith("[")) {
    const end = remote.indexOf("]");
    if (end > 0) return remote.slice(1, end);
  }
  const lastColon = remote.lastIndexOf(":");
  if (lastColon >= 0 && !remote.includes("]") && remote.split(":").length === 2) return remote.slice(0, lastColon);
  return remote;
}

export function parseBooleanQuery(value: string | undefined, name: string): boolean | { error: string; status: 400 } {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return { error: `invalid ${name} parameter; expected boolean`, status: 400 };
}

export function parseIntegerQuery(value: string | undefined, name: string): number | null | { error: string; status: 400 } {
  if (value === undefined || value === "") return null;
  if (!/^-?\d+$/.test(value)) return { error: `invalid ${name} parameter; expected integer`, status: 400 };
  return Number.parseInt(value, 10);
}
