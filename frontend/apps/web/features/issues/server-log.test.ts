import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import { readWithSessionCookie, SSR_LOG_TIMEOUT_MS } from "./server-log";

describe("Issue SSR cookie reader", () => {
  it("does not request without a cookie", async () => {
    const fetcher = vi.fn();
    expect(await readWithSessionCookie({ cookie: undefined, slug: "test", path: "/api/sessions/s/log", schema: z.array(z.string()), fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 503])("returns only the shell seed for HTTP %s", async status => {
    expect(await readWithSessionCookie({ cookie: "synthetic", slug: "test", path: "/log", schema: z.array(z.string()),
      fetcher: vi.fn(async () => new Response("upstream private error", { status })) as typeof fetch })).toBeNull();
  });
  it("uses the 800ms deadline and suppresses sensitive upstream errors", async () => {
    const errorLog = vi.spyOn(console, "error");
    const warnLog = vi.spyOn(console, "warn");
    const started = performance.now();
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic cookie must stay private")), { once: true });
    })) as unknown as typeof fetch;
    expect(await readWithSessionCookie({ cookie: "synthetic", slug: "test", path: "/log", schema: z.array(z.string()), fetcher })).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(SSR_LOG_TIMEOUT_MS - 20);
    expect(performance.now() - started).toBeLessThan(1_200);
    expect(errorLog).not.toHaveBeenCalled(); expect(warnLog).not.toHaveBeenCalled();
    errorLog.mockRestore(); warnLog.mockRestore();
  });
  it("forwards only the httpOnly cookie and workspace; invalid data cannot become a seed", async () => {
    const seen: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => { seen.push(init!); return Response.json({ unexpected: true }); }) as unknown as typeof fetch;
    expect(await readWithSessionCookie({ cookie: "synthetic", slug: "test", path: "/log", schema: z.array(z.string()), fetcher })).toBeNull();
    const headers = new Headers(seen[0]?.headers);
    expect(headers.has("cookie")).toBe(true); expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-workspace-slug")).toBe("test");
    expect(seen[0]?.cache).toBe("no-store"); expect(seen[0]?.redirect).toBe("error");
  });
});
