/**
 * How long a chat send waits for the server to accept the message (the session
 * read and the POST). Past it the send is unconfirmed rather than failed: the
 * server may still have committed it, and the log decides.
 */
export const CHAT_SEND_TIMEOUT_MS = 20_000;

/** A chat send that got no answer within {@link CHAT_SEND_TIMEOUT_MS}. */
export class ChatSendTimeoutError extends Error {
  constructor() {
    super("chat send timed out");
    this.name = "ChatSendTimeoutError";
  }
}

/**
 * Runs a send with a timeout: past it the requests are aborted and the promise
 * rejects with {@link ChatSendTimeoutError}, even if a request ignores the abort.
 */
export function withChatSendTimeout<T>(send: (signal: AbortSignal) => Promise<T>, timeoutMs = CHAT_SEND_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new ChatSendTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    send(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
