/**
 * Bun WebSocket adapter for Hono. `websocket` is exported from main.ts so
 * Bun.serve picks it up; `upgradeWebSocket` wires the /ws route in app.ts.
 */
import { createBunWebSocket } from "hono/bun";

export const { upgradeWebSocket, websocket } = createBunWebSocket();
