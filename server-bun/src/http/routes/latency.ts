/**
 * GET /api/latency-probe — tiny public endpoint the UI can sample to estimate
 * HTTP round-trip latency and client/server clock skew without touching the DB.
 */

import { Hono } from "hono";

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function latencyRoutes(): Hono {
  const r = new Hono();

  r.get("/api/latency-probe", (c) => {
    const serverReceivedAtMs = Date.now();
    const clientSentAtMs = parseFiniteNumber(c.req.query("client_sent_at_ms"));
    const probeId = c.req.query("probe_id") ?? c.req.header("X-Request-ID") ?? null;
    const serverSentAtMs = Date.now();

    c.header("Cache-Control", "no-store");
    c.header("Server-Timing", `app;dur=${Math.max(0, serverSentAtMs - serverReceivedAtMs)}`);

    return c.json({
      status: "ok",
      probe_id: probeId,
      client_sent_at_ms: clientSentAtMs,
      server_received_at_ms: serverReceivedAtMs,
      server_sent_at_ms: serverSentAtMs,
    });
  });

  return r;
}
