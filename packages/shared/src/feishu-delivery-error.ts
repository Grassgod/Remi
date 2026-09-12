/** Preserve the transport classification across the daemon/outbox boundary. */
export class FeishuDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly ambiguous = false) {
    super(message);
    this.name = "FeishuDeliveryError";
  }
}

export function isPermanentFeishuDeliveryError(error: unknown): boolean {
  return error instanceof FeishuDeliveryError && !error.retryable;
}
