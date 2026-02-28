/**
 * Connector protocol and shared types.
 */

import type { AgentResponse, StreamEvent } from "../providers/base.js";

/** A message received from any connector. */
export interface IncomingMessage {
  text: string;
  chatId: string;
  sender?: string;
  connectorName?: string;
  metadata?: Record<string, unknown>;
}

/** Callback type: core Remi.handleMessage (blocking, returns full response) */
export type MessageHandler = (msg: IncomingMessage) => Promise<AgentResponse>;

/**
 * Callback type: core Remi.handleMessageStream (real-time streaming).
 * Uses callback pattern so the lane lock covers the entire consumer lifecycle
 * (including card close + notifications), preventing concurrent message overlap.
 */
export type StreamingHandler = (
  msg: IncomingMessage,
  consumer: (stream: AsyncIterable<StreamEvent>) => Promise<void>,
) => Promise<void>;

/** Protocol that all input connectors must implement. */
export interface Connector {
  readonly name: string;

  /** Start listening for messages. Receives both blocking and streaming handlers. */
  start(handler: MessageHandler, streamHandler?: StreamingHandler): Promise<void>;

  /** Gracefully stop the connector. */
  stop(): Promise<void>;

  /** Send a response back to the given chat. */
  reply(chatId: string, response: AgentResponse): Promise<void>;
}
