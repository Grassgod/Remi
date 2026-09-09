import { describe, expect, it } from "bun:test";
import { OpenVikingClient, OpenVikingClientError } from "@multiremi/project-knowledge/openviking-client.js";

describe("OpenVikingClient", () => {
  it("allows cleanup deletes without waiting for semantic refresh and treats 404 as complete", async () => {
    const urls: string[] = [];
    const client = new OpenVikingClient({ baseUrl: "http://viking", apiKey: "secret", fetch: (async url => {
      urls.push(String(url));
      return Response.json({ status: "error", error: { code: "NOT_FOUND" } }, { status: 404 });
    }) as typeof fetch });
    await client.remove("viking://resources/old.md", { wait: false });
    await client.remove("viking://resources/old.md");
    expect(new URL(urls[0]!).searchParams.get("wait")).toBe("false");
    expect(new URL(urls[1]!).searchParams.get("wait")).toBe("true");
  });

  it("propagates cancellation to an in-flight read and does not retry it", async () => {
    const abort = new AbortController();
    let calls = 0;
    let requestSignal: AbortSignal | undefined;
    const entered = Promise.withResolvers<void>();
    const client = new OpenVikingClient({ baseUrl: "http://viking", apiKey: "secret", fetch: (async (_, init) => {
      calls++;
      requestSignal = init?.signal ?? undefined;
      entered.resolve();
      return new Promise((_, reject) => requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true }));
    }) as typeof fetch });
    const read = client.withSignal(abort.signal).read("viking://resources/old.md");
    await entered.promise;
    abort.abort(new Error("budget exhausted"));
    await expect(read).rejects.toThrow("budget exhausted");
    expect(requestSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("sends the API key only as bearer auth and retries transient search failures", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return Response.json({ status: "error", error: { message: "busy" } }, { status: 503 });
      }
      return Response.json({
        status: "ok",
        result: {
          resources: [{ uri: "viking://resources/multiremi/x.md", score: 0.91, abstract: "match", tags: ["project_id=p1"] }],
        },
      });
    }) as typeof fetch;
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal/",
      apiKey: "server-only-secret",
      maxRetries: 1,
      fetch: fetchImpl,
    });

    const hits = await client.find("release owner", "viking://resources/multiremi/projects/p1", 5, ["project_id=p1"]);

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => new Headers(call.init.headers).get("authorization") === "Bearer server-only-secret")).toBe(true);
    expect(calls.every((call) => !call.url.includes("server-only-secret"))).toBe(true);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      query: "release owner",
      target_uri: "viking://resources/multiremi/projects/p1",
      tags: ["project_id=p1"],
    });
    expect(hits).toEqual([{
      uri: "viking://resources/multiremi/x.md",
      score: 0.91,
      abstract: "match",
      tags: ["project_id=p1"],
    }]);
  });

  it("does not retry permanent failures or leak the API key in errors", async () => {
    let calls = 0;
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal",
      apiKey: "secret-from-env",
      maxRetries: 3,
      fetch: (async () => {
        calls++;
        return Response.json({ status: "error", error: { code: "BAD_URI", message: "bad secret-from-env" } }, { status: 400 });
      }) as unknown as typeof fetch,
    });

    let error: unknown;
    try {
      await client.read("viking://bad");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpenVikingClientError);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain("secret-from-env");
    expect(calls).toBe(1);
  });

  it("retries explicitly retryable OpenViking lock conflicts", async () => {
    let calls = 0;
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal",
      apiKey: "secret",
      maxRetries: 1,
      fetch: (async () => {
        calls++;
        if (calls === 1) {
          return Response.json({
            status: "error",
            error: { code: "CONFLICT", message: "resource busy", details: { retryable: true } },
          }, { status: 409 });
        }
        return Response.json({ status: "ok", result: {} });
      }) as unknown as typeof fetch,
    });

    await client.create(
      "viking://resources/multiremi/page.md",
      "viking://resources/multiremi",
      "content",
    );

    expect(calls).toBe(2);
  });

  it("accepts the plain health response used by OpenViking", async () => {
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal",
      apiKey: "secret",
      fetch: (async () => Response.json({ status: "healthy" })) as unknown as typeof fetch,
    });
    await expect(client.health()).resolves.toBeUndefined();
  });

  it("formats optimistic write hashes for the OpenViking wire protocol", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal",
      apiKey: "secret",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json({ status: "ok", result: {} });
      }) as typeof fetch,
    });
    const digest = "a".repeat(64);

    await client.replace(
      "viking://resources/multiremi/page.md",
      "viking://resources/multiremi",
      "updated",
      digest,
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      wait: false,
      operations: [{ precondition: { kind: "replace_if_hash", base_hash: `sha256:${digest}` } }],
    });
    await expect(client.replace(
      "viking://resources/multiremi/page.md",
      "viking://resources/multiremi",
      "updated",
      "not-a-digest",
    )).rejects.toThrow("OpenViking base hash must be a SHA-256 digest");
  });

  it("reads snapshot blobs from OpenViking's raw response", async () => {
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal",
      apiKey: "secret",
      fetch: (async () => new Response("historical content", {
        headers: { "Content-Type": "application/octet-stream" },
      })) as unknown as typeof fetch,
    });

    await expect(client.show("commit-oid", "viking://resources/multiremi/page.md"))
      .resolves.toBe("historical content");
  });

  it("classifies aborted requests as retryable timeouts", async () => {
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.internal",
      apiKey: "secret",
      maxRetries: 0,
      fetch: (async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({
      message: "OpenViking request timed out",
      retryable: true,
      status: null,
    });
  });
});
