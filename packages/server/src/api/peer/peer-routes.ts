/**
 * Peer channel HTTP surface (MUL-462, MUL-455 §1.4 item 3).
 *
 *   POST /internal/peer/events   one batch of events from the other process
 *   GET  /internal/peer/health   readiness probe for the split runbook
 *
 * Both are mounted under `/internal/`, which nginx never exposes: its only
 * upstreams are `/api`, `/ws`, `/auth`, and `/uploads`. Authentication is a
 * shared secret on its own — `MULTIREMI_PEER_SECRET`, falling back to
 * `MULTIREMI_TOKEN` — so a peer does not need a user or daemon credential, and
 * an unauthenticated caller gets 401 rather than the app's anonymous-admin path.
 *
 * Inbound events are handed to the local fanout, which delivers them to this
 * process's WebSocket registries and never forwards them again.
 */
import type { Context, Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { parsePeerEventBatch } from "@multiremi/contracts/peer-events.js";
import type { PeerChannel } from "./peer-channel.js";
import { PEER_REALTIME_TOPIC } from "./peer-channel.js";

export interface PeerRouteDeps {
  /** Null when `MULTIREMI_PEER_URL` is unset: the channel is closed, routes report that. */
  peer: PeerChannel | null;
  /** Shared secret the peer must present. Empty means every request is refused. */
  secret: string;
}

/** Constant-time secret comparison that tolerates a missing header. */
function secretMatches(supplied: string, expected: string): boolean {
  if (!expected || !supplied) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

function bearerToken(c: Context): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

export function registerPeerRoutes(app: Hono, deps: PeerRouteDeps): void {
  const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401);

  app.get("/internal/peer/health", (c) => {
    const peer = deps.peer;
    return c.json({
      ok: true,
      enabled: Boolean(peer),
      peer_healthy: peer ? peer.healthy() : false,
      ...(peer ? peer.stats() : {}),
    });
  });

  app.post("/internal/peer/events", async (c) => {
    if (!secretMatches(bearerToken(c), deps.secret)) return unauthorized(c);
    const peer = deps.peer;
    if (!peer) return c.json({ error: "peer channel disabled" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    // `realtime` is the default topic so a peer that only sends `{events}` is
    // still understood; anything else must name its topic.
    const batch = parsePeerEventBatch(body, PEER_REALTIME_TOPIC);
    if (!batch) return c.json({ error: "invalid batch" }, 400);
    const result = peer.receive(batch.topic, batch.events);
    return c.json({ ok: true, accepted: result.accepted, rejected: result.rejected });
  });
}
