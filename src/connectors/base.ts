/**
 * Connector protocol and shared types.
 */

import type { AgentResponse } from "../providers/base.js";

/** A message received from any connector. */
export interface IncomingMessage {
  text: string;
  chatId: string;
  sender?: string;
  connectorName?: string;
  metadata?: Record<string, unknown>;
}

/** Callback type: core Remi.handleMessage */
export type MessageHandler = (msg: IncomingMessage) => Promise<AgentResponse>;

/** Protocol that all input connectors must implement. */
export interface Connector {
  readonly name: string;

  /** Start listening for messages. Call handler for each incoming message. */
  start(handler: MessageHandler): Promise<void>;

  /** Gracefully stop the connector. */
  stop(): Promise<void>;

  /** Send a response back to the given chat. */
  reply(chatId: string, response: AgentResponse): Promise<void>;
}
