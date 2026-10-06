/** Five-minute startup migrations need a grace period before local rollback. */
export const DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS = 360_000;

export function resolveHealthTimeoutMs(value: string | number | undefined): number {
  const timeoutMs = value === undefined ? DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS must be a positive integer");
  }
  return timeoutMs;
}

interface HealthCheckRuntime {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  request?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
}

/** A wall-clock budget includes request time, unlike a fixed number of probes. */
export async function waitForHealthyUrl(
  url: string,
  timeoutMs: number,
  runtime: HealthCheckRuntime = {},
): Promise<void> {
  resolveHealthTimeoutMs(timeoutMs);
  const now = runtime.now ?? (() => performance.now());
  const sleep = runtime.sleep ?? ((ms: number) => Bun.sleep(ms));
  const request = runtime.request ?? fetch;
  const deadline = now() + timeoutMs;
  let lastError = "health check failed";
  while (now() < deadline) {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(5_000, deadline - now())))) });
      if (response.ok && now() < deadline) return;
      lastError = response.ok ? "readiness arrived after deadline" : `returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remainingMs = deadline - now();
    if (remainingMs > 0) await sleep(Math.min(2_500, remainingMs));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms: ${lastError}`);
}
