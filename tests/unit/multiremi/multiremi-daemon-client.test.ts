import { afterEach, describe, expect, it } from "bun:test";
import {
  isTerminalDaemonAuthorityError,
  MultiremiDaemonClient,
  MultiremiDaemonHttpError,
} from "@multiremi/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MultiremiDaemonClient HTTP failures", () => {
  it.each([401, 403, 410])("classifies HTTP %s as a terminal daemon authority failure", async (status) => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "daemon is no longer authorized", code: "daemon_retired" }),
      { status, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;

    const error = await new MultiremiDaemonClient("https://remi.example", "retired-token")
      .heartbeatRuntime("runtime-1")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MultiremiDaemonHttpError);
    expect(error).toMatchObject({ status, code: "daemon_retired" });
    expect(isTerminalDaemonAuthorityError(error)).toBe(true);
  });

  it("keeps transient server failures retryable", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "temporarily unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;

    const error = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .heartbeatRuntime("runtime-1")
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ status: 503 });
    expect(isTerminalDaemonAuthorityError(error)).toBe(false);
  });

  it("treats an old server without Agent Plugin routes as protocol zero", async () => {
    globalThis.fetch = (async () => new Response("404 Not Found", { status: 404 })) as unknown as typeof globalThis.fetch;

    await expect(new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .getRuntimeAgentPluginDesired("runtime-1"))
      .resolves.toEqual({
        runtime_id: "runtime-1",
        revision: "unsupported",
        plugins: [],
      });
  });

  it("does not hide a structured runtime-not-found Agent Plugin response", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "runtime not found", code: "runtime_not_found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;

    const error = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .getRuntimeAgentPluginDesired("runtime-1")
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ status: 404, code: "runtime_not_found" });
  });
});
