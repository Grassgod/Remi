import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayShimChannel, GatewayShimEvent } from "@acp/access/gateway-shim-types.js";
import { AntigravityGatewayShim, type AntigravityGatewayShimOptions } from "@daemon/agent-runtime/antigravity/gateway-shim.js";
import { GeminiResponseScanner } from "@daemon/agent-runtime/antigravity/gemini-sse.js";

const REAL_KEY = "gw-real-key-0123456789";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

interface Seen { method: string; path: string; search: string; headers: Record<string, string>; body: string }

/** A fake Gemini gateway; `respond` decides each answer. */
function upstream(respond: (request: Request, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const entry: Seen = { method: request.method, path: url.pathname, search: url.search,
        headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.text() : "" };
      seen.push(entry);
      return respond(request, entry);
    },
  });
  cleanups.push(() => server.stop(true));
  return { seen, base: `http://127.0.0.1:${server.port}/antigravity` };
}

function shimFor(base: string, options: AntigravityGatewayShimOptions = {}) {
  const shim = new AntigravityGatewayShim({ assertUpstream: async () => {}, ...options });
  cleanups.push(() => shim.stop());
  const raw = shim.forRun({ upstreamBase: base, apiKey: REAL_KEY, runId: "run-1" });
  // Channels with a prompt active, as the provider holds one during every turn.
  const run = { runId: raw.runId, close: () => raw.close(), open: (label: string) => {
    const channel = raw.open(label);
    channel.beginPrompt();
    return channel;
  } };
  return { shim, run, raw };
}

/** Observations and breaker events; `request_started` is asserted on its own. */
function record(channel: GatewayShimChannel) {
  const events: GatewayShimEvent[] = [];
  channel.subscribe((event) => { if (event.type !== "request_started" && event.type !== "listing") events.push(event); });
  return events;
}

const PLACEHOLDER_HEADERS = { authorization: "Bearer remi-shim", "x-goog-api-key": "remi-shim", cookie: "a=b",
  "x-forwarded-for": "1.2.3.4", "content-type": "application/json", "x-goog-api-client": "harness/1" };
const sse = (...chunks: unknown[]) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("");
const USAGE_1 = { promptTokenCount: 120, totalTokenCount: 120 };
const USAGE_2 = { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 130,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: 120 }] };

describe("Antigravity gateway shim", () => {
  it("binds loopback, strips inbound credentials and injects the real Bearer key", async () => {
    const gateway = upstream(() => Response.json({ models: [] }, { headers: { "set-cookie": "s=1", "x-upstream": "yes" } }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("test");
    expect(channel.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r_[A-Za-z0-9_-]{43}$/);
    const response = await fetch(`${channel.baseUrl}/v1beta/models?pageSize=1000&key=remi-shim`, { headers: PLACEHOLDER_HEADERS });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream")).toBe("yes");
    const [request] = gateway.seen;
    expect(request!.path).toBe("/antigravity/v1beta/models");
    expect(request!.search).toBe("?pageSize=1000");
    expect(request!.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(request!.headers["x-goog-api-key"]).toBeUndefined();
    expect(request!.headers.cookie).toBeUndefined();
    expect(request!.headers["x-forwarded-for"]).toBeUndefined();
    expect(request!.headers["x-goog-api-client"]).toBe("harness/1");
    // The token never reaches the gateway.
    expect(JSON.stringify(request)).not.toContain(channel.baseUrl.split("/").pop()!);
  });

  it("serves only the allowlisted Gemini routes, with one 404 for unknown, revoked and disallowed", async () => {
    const gateway = upstream(() => Response.json({ ok: true }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("routes");
    const call = (path: string, method = "GET") => fetch(`${channel.baseUrl}/${path}`, { method, body: method === "POST" ? "{}" : undefined });
    for (const [path, method] of [["v1beta/models", "GET"], ["v1beta/models/", "GET"], ["v1/models", "GET"], ["v1beta/models/gemini-3.7-flash", "GET"],
      ["v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse", "POST"], ["v1beta/models/gemini-3.7-flash:generateContent", "POST"],
      ["v1beta/models/gemini-3.7-flash:countTokens", "POST"], ["v1beta/models/gemini-3.7-flash%3AcountTokens", "POST"]] as const) {
      expect([path, (await call(path, method)).status]).toEqual([path, 200]);
    }
    const reference = await (await fetch(`http://127.0.0.1:${new URL(channel.baseUrl).port}/r_${"A".repeat(43)}/v1beta/models`)).text();
    for (const [path, method] of [["v1beta/models", "POST"], ["v1beta/files", "GET"], ["v1beta/models/m:embedContent", "POST"],
      ["v1beta/models/../../admin", "GET"], ["v1beta/models/m/extra", "GET"], ["v1beta/tunedModels", "GET"], ["", "GET"]] as const) {
      const response = await call(path, method);
      expect([path, response.status, await response.text()]).toEqual([path, 404, reference]);
    }
    const before = gateway.seen.length;
    channel.close();
    const revoked = await call("v1beta/models");
    expect([revoked.status, await revoked.text()]).toEqual([404, reference]);
    expect(gateway.seen.length).toBe(before);
    const otherPort = await fetch(`http://127.0.0.1:${new URL(channel.baseUrl).port}/v1beta/models`);
    expect([otherPort.status, await otherPort.text()]).toEqual([404, reference]);
  });

  it("passes SSE bytes through unchanged and observes the last usageMetadata", async () => {
    const payload = sse({ responseId: "resp-1", modelVersion: "gemini-3.7-flash-001", candidates: [{ content: { parts: [{ text: "Hel" }] } }], usageMetadata: USAGE_1 },
      { responseId: "resp-1", modelVersion: "gemini-3.7-flash-001", candidates: [{ content: { parts: [{ text: "lo ✓" }] } }], usageMetadata: USAGE_2 });
    const gateway = upstream(() => new Response(payload, { headers: { "content-type": "text/event-stream", "content-encoding": "identity" } }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("sse");
    const events = record(channel);
    const response = await fetch(`${channel.baseUrl}/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse`, { method: "POST", headers: PLACEHOLDER_HEADERS, body: '{"contents":[]}' });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(payload));
    await channel.settled(1000);
    expect(gateway.seen[0]!.body).toBe('{"contents":[]}');
    expect(events).toEqual([{ type: "request", obs: { seq: 1, requestedModel: "gemini-3.7-flash", status: 200, aborted: false,
      responseId: "resp-1", modelVersion: "gemini-3.7-flash-001",
      usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 130 } } }]);
  });

  it("announces each model call as it starts, before its observation", async () => {
    const gateway = upstream(() => Response.json({ responseId: "r", usageMetadata: USAGE_1 }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("starts");
    const types: string[] = [];
    channel.subscribe((event) => types.push(event.type === "request_started" ? `started:${event.requestedModel}` : event.type));
    await (await fetch(`${channel.baseUrl}/v1beta/models`)).text();
    await (await fetch(`${channel.baseUrl}/v1beta/models/m:countTokens`, { method: "POST", body: "{}" })).text();
    await (await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).text();
    await channel.settled(1000);
    // Listings report how they ended; countTokens is neither metered nor reported.
    expect(types).toEqual(["listing", "started:m", "request"]);
  });

  it("refuses model calls outside an active prompt with a fast 503, still serving listings", async () => {
    const gateway = upstream(() => Response.json({ responseId: "r", usageMetadata: USAGE_1 }));
    const { raw } = shimFor(gateway.base);
    const channel = raw.open("gate");
    const events = record(channel);
    expect((await fetch(`${channel.baseUrl}/v1beta/models`)).status).toBe(200);
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:countTokens`, { method: "POST", body: "{}" })).status).toBe(200);
    // A backgrounded command calling the gateway after the turn: refused, never forwarded, nothing to bill.
    const refused = await fetch(`${channel.baseUrl}/v1beta/models/m:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    expect(gateway.seen.filter((seen) => seen.path.includes(":streamGenerateContent"))).toHaveLength(0);
    const end = channel.beginPrompt();
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).status).toBe(200);
    end();
    end();
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).status).toBe(503);
    await channel.settled(1000);
    expect(events.filter((event) => event.type === "request")).toHaveLength(1);
    // Refusals are not gateway failures.
    expect(events.some((event) => event.type === "fatal")).toBe(false);
  });

  it("reports how every model listing ended, even with no prompt", async () => {
    let status = 200;
    const gateway = upstream(() => status === 200 ? Response.json({ models: [] }) : new Response("no", { status }));
    const { raw } = shimFor(gateway.base);
    const channel = raw.open("listings");
    const listings: unknown[] = [];
    channel.subscribe((event) => { if (event.type === "listing") listings.push(event); });
    for (const next of [200, 401, 503, 429]) {
      status = next;
      await (await fetch(`${channel.baseUrl}/v1beta/models?pageSize=1000`)).text();
    }
    expect(listings).toEqual([
      { type: "listing", status: 200, failure: null },
      { type: "listing", status: 401, failure: { reason: "auth", status: 401, message: expect.any(String) } },
      // The 401 opened the breaker: later listings are not forwarded (and not reported).
    ]);
  });

  it("cuts the model calls still in flight on request, each with an aborted observation", async () => {
    const gateway = upstream(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse({ responseId: "resp-open", usageMetadata: USAGE_1 })));
    } }), { headers: { "content-type": "text/event-stream" } }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("abort-inflight");
    const events = record(channel);
    const response = await fetch(`${channel.baseUrl}/v1beta/models/m:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" });
    await response.body!.getReader().read();
    channel.abortInflight();
    await channel.settled(2000);
    expect(events).toMatchObject([{ type: "request", obs: { aborted: true, responseId: "resp-open", usageMetadata: USAGE_1 } }]);
  }, 15_000);

  it("forgets a closed run and drops its key, with or without channels", () => {
    const shim = new AntigravityGatewayShim({ assertUpstream: async () => {} });
    cleanups.push(() => shim.stop());
    const unused = shim.forRun({ upstreamBase: "https://gw.example/antigravity", apiKey: REAL_KEY, runId: "never-opened" });
    const used = shim.forRun({ upstreamBase: "https://gw.example/antigravity", apiKey: REAL_KEY, runId: "opened" });
    used.open("one");
    expect(shim.openRuns).toBe(2);
    unused.close();
    used.close();
    expect(shim.openRuns).toBe(0);
    expect(JSON.stringify(unused)).not.toContain(REAL_KEY);
    expect(JSON.stringify(used)).not.toContain(REAL_KEY);
  });

  it("observes non-stream JSON responses and never meters listings or countTokens", async () => {
    const gateway = upstream((_request, seen) => seen.path.endsWith(":generateContent")
      ? Response.json({ responseId: "resp-json", modelVersion: "m-1", usageMetadata: USAGE_1 })
      : Response.json({ totalTokens: 5 }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("json");
    const events = record(channel);
    await (await fetch(`${channel.baseUrl}/v1beta/models/m:countTokens`, { method: "POST", body: "{}" })).text();
    await (await fetch(`${channel.baseUrl}/v1beta/models`)).text();
    await (await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).text();
    await channel.settled(1000);
    expect(events.map((event) => event.type === "request" ? [event.obs.requestedModel, event.obs.responseId, event.obs.usageMetadata] : event)).toEqual([
      ["m", "resp-json", USAGE_1],
    ]);
  });

  it("reports a client-aborted stream as aborted with only the counters seen so far", async () => {
    let upstreamAborted = false;
    const gateway = upstream((request) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ responseId: "resp-cut", usageMetadata: USAGE_1 })));
        request.signal.addEventListener("abort", () => { upstreamAborted = true; });
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("abort");
    const events = record(channel);
    const client = new AbortController();
    const response = await fetch(`${channel.baseUrl}/v1beta/models/m:streamGenerateContent?alt=sse`, { method: "POST", body: "{}", signal: client.signal });
    const reader = response.body!.getReader();
    await reader.read();
    client.abort();
    await reader.cancel().catch(() => {});
    await channel.settled(2000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "request", obs: { aborted: true, status: 200, responseId: "resp-cut", usageMetadata: USAGE_1 } });
    for (let i = 0; i < 50 && !upstreamAborted; i++) await Bun.sleep(10);
    expect(upstreamAborted).toBe(true);
  });

  it("cuts a stalled stream after the idle timeout and answers 504 without a first byte", async () => {
    const gateway = upstream((_request, seen) => seen.path.includes("slow")
      ? new Promise<Response>(() => {})
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse({ usageMetadata: USAGE_1 }))); } }),
        { headers: { "content-type": "text/event-stream" } }));
    const { run } = shimFor(gateway.base, { limits: { idleMs: 80, firstByteMs: 80 } });
    const channel = run.open("timeouts");
    const events = record(channel);
    const stalled = await fetch(`${channel.baseUrl}/v1beta/models/m:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" });
    // The connection drops instead of ending cleanly, so the harness never takes a cut stream for a complete one.
    expect(await stalled.text().then(() => "complete", () => "cut")).toBe("cut");
    const slow = await fetch(`${channel.baseUrl}/v1beta/models/slow:generateContent`, { method: "POST", body: "{}" });
    expect(slow.status).toBe(504);
    await channel.settled(1000);
    expect(events.map((event) => event.type === "request" ? [event.obs.requestedModel, event.obs.status, event.obs.aborted, event.obs.usageMetadata] : event.type)).toEqual([
      ["m", 200, true, USAGE_1], ["slow", 0, true, null],
    ]);
  }, 15_000);

  it("opens the breaker at once on 401 and answers 503 afterwards", async () => {
    const gateway = upstream(() => Response.json({ error: { code: 401 } }, { status: 401 }));
    const { run } = shimFor(gateway.base);
    const channel = run.open("auth");
    const events = record(channel);
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).status).toBe(401);
    await channel.settled(1000);
    const fatal = events.find((event) => event.type === "fatal");
    expect(fatal).toEqual({ type: "fatal", reason: "auth", status: 401, message: expect.any(String) });
    expect(JSON.stringify(fatal)).not.toContain(REAL_KEY);
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).status).toBe(503);
    expect(gateway.seen).toHaveLength(1);
    // Another channel of the same run keeps its own breaker.
    expect((await fetch(`${run.open("other").baseUrl}/v1beta/models`)).status).toBe(401);
  });

  it("opens the breaker after 5 consecutive failures or 180 s of failing, as unreachable or quota", async () => {
    let status = 500;
    const gateway = upstream(() => new Response("busy", { status }));
    let now = 0;
    const { run } = shimFor(gateway.base, { now: () => now });
    const call = (channel: GatewayShimChannel) => fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" }).then((r) => r.status);

    const consecutive = run.open("5xx");
    const fatal5xx = record(consecutive);
    for (let i = 0; i < 4; i++) expect(await call(consecutive)).toBe(500);
    expect(fatal5xx.some((event) => event.type === "fatal")).toBe(false);
    expect(await call(consecutive)).toBe(500);
    expect(fatal5xx.filter((event) => event.type === "fatal")).toEqual([{ type: "fatal", reason: "unreachable", status: 500, message: expect.any(String) }]);
    expect(await call(consecutive)).toBe(503);

    status = 429;
    const window = run.open("429");
    const fatal429 = record(window);
    expect(await call(window)).toBe(429);
    now += 181_000;
    expect(await call(window)).toBe(429);
    expect(fatal429.filter((event) => event.type === "fatal")).toEqual([{ type: "fatal", reason: "quota", status: 429, message: expect.any(String) }]);

    // A success resets the count.
    const reset = run.open("reset");
    const resetEvents = record(reset);
    for (let i = 0; i < 4; i++) { status = 503; await call(reset); }
    status = 200;
    await call(reset);
    for (let i = 0; i < 4; i++) { status = 503; await call(reset); }
    expect(resetEvents.some((event) => event.type === "fatal")).toBe(false);
  });

  it("records a network failure as status 0, not aborted, and counts it toward the breaker", async () => {
    const shim = new AntigravityGatewayShim({ assertUpstream: async () => {}, fetch: async () => { throw Object.assign(new Error(`connect ${REAL_KEY}`), { code: "ECONNREFUSED" }); } });
    cleanups.push(() => shim.stop());
    const channel = shim.forRun({ upstreamBase: "https://gateway.example/antigravity", apiKey: REAL_KEY, runId: "net" }).open("net");
    channel.beginPrompt();
    const events = record(channel);
    for (let i = 0; i < 5; i++) expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" })).status).toBe(502);
    await channel.settled(1000);
    expect(events.filter((event) => event.type === "request").map((event) => event.type === "request" && [event.obs.status, event.obs.aborted])).toEqual(
      Array(5).fill([0, false]));
    const fatal = events.find((event) => event.type === "fatal");
    expect(fatal).toMatchObject({ reason: "unreachable", status: null });
    expect(JSON.stringify(fatal)).not.toContain(REAL_KEY);
    expect(JSON.stringify(fatal)).toContain("ECONNREFUSED");
  });

  it("caps the request body and rejects private or plain-http upstreams by default", async () => {
    const gateway = upstream(() => Response.json({}));
    const { run } = shimFor(gateway.base, { limits: { requestBodyBytes: 16 } });
    const channel = run.open("cap");
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "x".repeat(17) })).status).toBe(413);
    expect((await fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "x".repeat(16) })).status).toBe(200);

    const guarded = new AntigravityGatewayShim();
    cleanups.push(() => guarded.stop());
    const plain = guarded.forRun({ upstreamBase: gateway.base, apiKey: REAL_KEY, runId: "guard" }).open("guard");
    expect((await fetch(`${plain.baseUrl}/v1beta/models`)).status).toBe(502);
    const loopback = guarded.forRun({ upstreamBase: "https://127.0.0.1:9/antigravity", apiKey: REAL_KEY, runId: "guard" }).open("guard");
    expect((await fetch(`${loopback.baseUrl}/v1beta/models`)).status).toBe(502);
    expect(gateway.seen).toHaveLength(1);
  });

  it("validates the run's upstream and key", () => {
    const shim = new AntigravityGatewayShim();
    cleanups.push(() => shim.stop());
    for (const [upstreamBase, apiKey] of [["https://gw.example/v1beta", "k"], ["https://gw.example/x?key=1", "k"], ["not a url", "k"], ["https://gw.example", " "]]) {
      expect(() => shim.forRun({ upstreamBase: upstreamBase!, apiKey: apiKey!, runId: "r" })).toThrow("[antigravity_gateway_unconfigured]");
    }
    const run = shim.forRun({ upstreamBase: "https://gw.example/antigravity/", apiKey: "k", runId: "r" });
    run.close();
    expect(() => run.open("late")).toThrow("closed");
  });

  it("settles when every metered request has reported, or after the bound", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gateway = upstream(async () => { await gate; return Response.json({ responseId: "late", usageMetadata: USAGE_1 }); });
    const { run } = shimFor(gateway.base);
    const channel = run.open("settle");
    const events = record(channel);
    await channel.settled(10);
    const pending = fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" });
    while (!gateway.seen.length) await Bun.sleep(5);
    const started = performance.now();
    await channel.settled(60);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(events).toHaveLength(0);
    const settled = channel.settled(5000);
    release();
    await (await pending).text();
    await settled;
    expect(events).toHaveLength(1);
  });

  it("revokes every channel of a run at close and aborts its requests", async () => {
    const gateway = upstream(() => new Promise<Response>(() => {}));
    const { run } = shimFor(gateway.base);
    const channel = run.open("close");
    const events = record(channel);
    const pending = fetch(`${channel.baseUrl}/v1beta/models/m:generateContent`, { method: "POST", body: "{}" }).then((r) => r.status);
    while (!gateway.seen.length) await Bun.sleep(5);
    run.close();
    expect(await pending).toBe(499);
    expect(events).toHaveLength(0);
    expect((await fetch(`${channel.baseUrl}/v1beta/models`)).status).toBe(404);
  });
});

describe("Gemini response scanner", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("reads SSE events split across chunks and CRLF, skipping comments and malformed data", () => {
    const scanner = new GeminiResponseScanner("sse");
    const text = `: keep-alive\r\n\r\ndata: {"responseId":"a","usageMetadata":{"promptTokenCount":1}}\r\n\r\ndata: not-json\n\ndata: {"responseId":"b",\ndata: "usageMetadata":{"promptTokenCount":2,"totalTokenCount":3}}\n\n`;
    for (let i = 0; i < text.length; i += 7) scanner.push(bytes(text.slice(i, i + 7)));
    expect(scanner.end()).toEqual({ responseId: "b", modelVersion: null, usageMetadata: { promptTokenCount: 2, totalTokenCount: 3 } });
  });

  it("never parses an event over the cap, and keeps reading after it", () => {
    const scanner = new GeminiResponseScanner("sse", { sseEventBytes: 64 });
    scanner.push(bytes(`data: {"responseId":"ok","usageMetadata":{"promptTokenCount":1}}\n\n`));
    scanner.push(bytes(`data: {"responseId":"huge","pad":"${"x".repeat(100)}`));
    scanner.push(bytes(`${"y".repeat(100)}","usageMetadata":{"promptTokenCount":999}}\n\n`));
    expect(scanner.result.responseId).toBe("ok");
    scanner.push(bytes(`data: {"usageMetadata":{"promptTokenCount":2}}\n\n`));
    expect(scanner.end()).toEqual({ responseId: "ok", modelVersion: null, usageMetadata: { promptTokenCount: 2 } });
  });

  it("reads a JSON array stream and stops buffering over the JSON cap", () => {
    const array = new GeminiResponseScanner("json");
    array.push(bytes(JSON.stringify([{ responseId: "r", usageMetadata: { promptTokenCount: 1 } }, { modelVersion: "v", usageMetadata: { promptTokenCount: 4 } }])));
    expect(array.end()).toEqual({ responseId: "r", modelVersion: "v", usageMetadata: { promptTokenCount: 4 } });
    const capped = new GeminiResponseScanner("json", { jsonBytes: 10 });
    capped.push(bytes(JSON.stringify({ responseId: "too-big", usageMetadata: { promptTokenCount: 1 } })));
    expect(capped.end()).toEqual({ responseId: null, modelVersion: null, usageMetadata: null });
  });
});
