/**
 * Realtime hub: bridges the EventBus to connected WebSocket clients. Decoupled
 * from the WS transport (takes a minimal SocketLike) so it is unit-testable and
 * works with Bun's native WebSocket via hono/bun in app.ts.
 */

import type { EventBus, BusEvent } from "./bus.js";

export interface SocketLike {
  send(data: string): void;
}

function toWire(e: BusEvent): string {
  return JSON.stringify({ type: e.type, workspace_id: e.workspaceId, payload: e.payload ?? {} });
}

/**
 * Subscribe a client socket to a workspace's events; each bus event is
 * forwarded as a JSON frame. Returns detach() to call on socket close.
 */
export function attachClient(bus: EventBus, workspaceId: string, socket: SocketLike): () => void {
  return bus.subscribe(workspaceId, (e) => socket.send(toWire(e)));
}
