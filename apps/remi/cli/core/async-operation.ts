import { CliError } from "./errors.js";

export interface AsyncOperationSpec<T> {
  status(operationId: string): Promise<T>;
  cancel(operationId: string): Promise<T>;
  state(operation: T): string;
  terminalStates: readonly string[];
  successStates: readonly string[];
  failureDetails?(operation: T): unknown;
}

export interface AsyncOperationWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AsyncOperationController<T> {
  constructor(private readonly spec: AsyncOperationSpec<T>) {
    if (!spec.terminalStates.length) throw new Error("async operation terminalStates are required");
    const nonTerminalSuccess = spec.successStates.find((state) => !spec.terminalStates.includes(state));
    if (nonTerminalSuccess) throw new Error(`async operation success state is not terminal: ${nonTerminalSuccess}`);
  }

  status(operationId: string): Promise<T> {
    return this.spec.status(requireOperationId(operationId));
  }

  cancel(operationId: string): Promise<T> {
    return this.spec.cancel(requireOperationId(operationId));
  }

  async wait(operationId: string, options: AsyncOperationWaitOptions = {}): Promise<T> {
    const id = requireOperationId(operationId);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 10 * 60_000, "timeoutMs");
    const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();
    while (true) {
      const operation = await this.spec.status(id);
      const state = this.spec.state(operation);
      if (this.spec.terminalStates.includes(state)) {
        if (this.spec.successStates.includes(state)) return operation;
        throw new CliError("server", `operation ${id} ended in ${state}`, {
          details: this.spec.failureDetails?.(operation) ?? operation,
        });
      }
      const elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new CliError("timeout", `operation ${id} did not finish within ${timeoutMs}ms`, {
          retryable: true,
          details: { operation_id: id, state },
        });
      }
      await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
    }
  }
}

function requireOperationId(value: string): string {
  const id = value.trim();
  if (!id) throw new CliError("usage", "operation ID is required");
  return id;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliError("usage", `${label} must be a positive integer`);
  return value;
}
