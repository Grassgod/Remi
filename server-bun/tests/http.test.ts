import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.js";
import { issueJWT, verifyJWT } from "../src/auth/jwt.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const cfg: Config = {
  port: 0,
  jwtSecret: SECRET,
  authTokenTtlSeconds: 3600,
  databaseUrl: "",
  allowedEmailDomains: [],
};

test("GET /health → ok", async () => {
  const res = await createApp(cfg).request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET /api/latency-probe is public and returns timing fields", async () => {
  const before = Date.now();
  const res = await createApp(cfg).request("/api/latency-probe?client_sent_at_ms=123.5&probe_id=ui-1");
  const after = Date.now();
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Server-Timing")).toMatch(/^app;dur=\d+$/);

  const body = (await res.json()) as {
    status: string;
    probe_id: string | null;
    client_sent_at_ms: number | null;
    server_received_at_ms: number;
    server_sent_at_ms: number;
  };
  expect(body.status).toBe("ok");
  expect(body.probe_id).toBe("ui-1");
  expect(body.client_sent_at_ms).toBe(123.5);
  expect(body.server_received_at_ms).toBeGreaterThanOrEqual(before);
  expect(body.server_sent_at_ms).toBeGreaterThanOrEqual(body.server_received_at_ms);
  expect(body.server_sent_at_ms).toBeLessThanOrEqual(after);
});

test("GET /api/latency-probe falls back to X-Request-ID and ignores invalid client timestamps", async () => {
  const res = await createApp(cfg).request("/api/latency-probe?client_sent_at_ms=not-a-number", {
    headers: { "X-Request-ID": "req-123" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { probe_id: string | null; client_sent_at_ms: number | null };
  expect(body.probe_id).toBe("req-123");
  expect(body.client_sent_at_ms).toBeNull();
});

test("GET /api/me without a token → 401", async () => {
  const res = await createApp(cfg).request("/api/me");
  expect(res.status).toBe(401);
});

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

// /api/me now loads the full user from the DB; with no DB configured a valid
// token passes the gate and reaches the handler, which 503s. A 503 (not 401)
// therefore proves the bearer token cleared the auth gate.
test("a valid bearer token clears the auth gate (reaches the DB-less handler)", async () => {
  const token = await issueJWT({ sub: U1, email: "a@bytedance.com", name: "Alice" }, SECRET);
  const res = await createApp(cfg).request("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(503);
});

test("a valid multimira_token cookie also clears the auth gate", async () => {
  const token = await issueJWT({ sub: U2, email: "b@bytedance.com", name: "Bob" }, SECRET);
  const res = await createApp(cfg).request("/api/me", {
    headers: { Cookie: `multimira_token=${encodeURIComponent(token)}` },
  });
  expect(res.status).toBe(503);
});

test("a validly-signed token with a non-UUID sub is rejected with 401 (not a 500)", async () => {
  // Regression: a malformed sub used to flow into a uuid DB column and 500.
  const token = await issueJWT({ sub: "not-a-uuid", email: "x@bytedance.com", name: "X" }, SECRET);
  const res = await createApp(cfg).request("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(401);
});

test("verifyJWT rejects a token signed with a different secret", async () => {
  const token = await issueJWT({ sub: "u3", email: "c@x.com", name: "C" }, "other-secret");
  await expect(verifyJWT(token, SECRET)).rejects.toThrow();
});
