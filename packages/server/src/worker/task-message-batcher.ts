import type { TaskMessageInput } from "@multiremi/contracts/types.js";

export const DEFAULT_TASK_MESSAGE_FLUSH_INTERVAL_MS = 200;
export const DEFAULT_TASK_MESSAGE_BATCH_BYTES = 16 * 1024;
export const DEFAULT_TASK_MESSAGE_CONTENT_BYTES = 64 * 1024;
export const DEFAULT_TASK_MESSAGE_BATCH_COUNT = 256;

const STREAM_MESSAGE_TYPES = new Set(["text", "thinking"]);

export interface TaskMessageBatcherOptions {
  emit: (messages: TaskMessageInput[]) => void;
  flushIntervalMs?: number;
  maxBatchBytes?: number;
  maxContentBytes?: number;
  maxBatchCount?: number;
}

/**
 * Coalesces adjacent token chunks without crossing tool, plan, compaction, or
 * subagent boundaries. The first chunk's seq is retained; gaps are valid and
 * keep retries idempotent when this is also used for persisted outbox rows.
 */
export function coalesceTaskMessages(
  messages: TaskMessageInput[],
  maxContentBytes = DEFAULT_TASK_MESSAGE_CONTENT_BYTES,
): TaskMessageInput[] {
  const output: TaskMessageInput[] = [];
  const contentLimit = Math.max(1, maxContentBytes);
  for (const message of messages) {
    const previous = output.at(-1);
    if (previous && canCoalesce(previous, message, contentLimit)) {
      previous.content = `${previous.content ?? ""}${message.content ?? ""}`;
      continue;
    }
    output.push({ ...message });
  }
  return output;
}

/**
 * Small in-memory front buffer for live ACP events. It preserves interactive
 * streaming while preventing one durable SQLite row and one HTTP request per
 * provider token.
 */
export class TaskMessageBatcher {
  private readonly emit: (messages: TaskMessageInput[]) => void;
  private readonly flushIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly maxContentBytes: number;
  private readonly maxBatchCount: number;
  private pending: TaskMessageInput[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TaskMessageBatcherOptions) {
    this.emit = options.emit;
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_TASK_MESSAGE_FLUSH_INTERVAL_MS);
    this.maxBatchBytes = Math.max(1, options.maxBatchBytes ?? DEFAULT_TASK_MESSAGE_BATCH_BYTES);
    this.maxContentBytes = Math.max(1, options.maxContentBytes ?? DEFAULT_TASK_MESSAGE_CONTENT_BYTES);
    this.maxBatchCount = Math.max(1, options.maxBatchCount ?? DEFAULT_TASK_MESSAGE_BATCH_COUNT);
  }

  push(messages: TaskMessageInput[]): void {
    if (!messages.length) return;
    let hasBoundary = false;
    for (const message of messages) {
      const previous = this.pending.at(-1);
      if (previous && canCoalesce(previous, message, this.maxContentBytes)) {
        previous.content = `${previous.content ?? ""}${message.content ?? ""}`;
      } else {
        this.pending.push({ ...message });
      }
      this.pendingBytes += taskMessageBytes(message);
      if (!isStreamMessage(message)) hasBoundary = true;
      if (
        this.pendingBytes >= this.maxBatchBytes
        || this.pending.length >= this.maxBatchCount
      ) {
        this.flush();
        hasBoundary = false;
      }
    }

    if (hasBoundary) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  flush(): void {
    if (!this.pending.length) {
      this.clearTimer();
      return;
    }
    const messages = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.clearTimer();
    this.emit(messages);
  }

  close(): void {
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

function canCoalesce(
  previous: TaskMessageInput,
  next: TaskMessageInput,
  maxContentBytes: number,
): boolean {
  if (!isStreamMessage(previous) || !isStreamMessage(next)) return false;
  if (previous.type !== next.type) return false;
  if (JSON.stringify(previous.meta ?? null) !== JSON.stringify(next.meta ?? null)) return false;
  return Buffer.byteLength(`${previous.content ?? ""}${next.content ?? ""}`, "utf8") <= maxContentBytes;
}

function isStreamMessage(message: TaskMessageInput): boolean {
  return STREAM_MESSAGE_TYPES.has(message.type)
    && typeof message.content === "string"
    && message.tool == null
    && message.input == null
    && message.output == null
    && message.toolCallId == null
    && message.status == null;
}

function taskMessageBytes(message: TaskMessageInput): number {
  return Buffer.byteLength(message.content ?? "", "utf8")
    + Buffer.byteLength(message.output ?? "", "utf8")
    + 128;
}
