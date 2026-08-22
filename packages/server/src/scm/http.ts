export class ScmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    readonly responseBody: string,
  ) {
    super(message);
  }
}

export interface ScmHttpResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export async function scmRequestJson<T>(
  url: string,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ScmHttpResponse<T>> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal, redirect: "error" });
  const text = await response.text();
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ScmHttpError(
      `SCM provider request failed (${response.status})`,
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
      text.slice(0, 2_000),
    );
  }
  let data: T;
  try {
    data = (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new ScmHttpError("SCM provider returned invalid JSON", response.status, null, text.slice(0, 2_000));
  }
  return { data, headers: response.headers, status: response.status };
}

export function appendQuery(url: string, values: Record<string, string | number | boolean | null | undefined>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "") continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

export function lowerCaseHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  if (headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

export function hasNextLink(value: string | null): boolean {
  if (!value) return false;
  return value.split(",").some((part) => /;\s*rel="next"\s*$/u.test(part.trim()));
}

