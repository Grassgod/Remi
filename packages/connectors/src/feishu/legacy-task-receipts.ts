import type { Client } from "@larksuiteoapi/node-sdk";
import type { TaskStreamEvent } from "@connectors/base.js";
import { setFeishuMessageReceipt, type FeishuMessageReceipt } from "./message-receipt.js";

/** Compatibility adapter for a Task pinned to an undeclared daemon's bundled delivery. */
export class FeishuLegacyTaskReceipts {
  private readonly messageIds: Set<string>;
  constructor(private readonly client: Client, private readonly appId: string,
    private readonly signal: AbortSignal, private readonly resultSent: () => boolean,
    messageIds: string[] = [], private readonly log?: (message: string) => void) {
    this.messageIds = new Set(messageIds);
  }

  async consume<T>(stream: AsyncIterable<TaskStreamEvent>, present: (events: AsyncIterable<TaskStreamEvent>) => Promise<T>): Promise<T> {
    if (!this.resultSent()) await this.receipt("received");
    let status = "running";
    const receipts = this;
    async function* observe() {
      for await (const event of stream) {
        if (event.kind === "snapshot") {
          status = event.snapshot.status;
          for (const id of event.snapshot.receiptMessageIds ?? []) receipts.messageIds.add(id);
        }
        yield event;
      }
    }
    try {
      const result = await present(observe());
      await this.receipt(status === "completed" ? "completed" : "failed");
      return result;
    } catch (error) {
      if (!this.signal.aborted && !this.resultSent()) {
        await this.receipt("failed").catch(failure => this.log?.(`Failure receipt update failed: ${String(failure)}`));
      }
      throw error;
    }
  }

  private async receipt(state: FeishuMessageReceipt) {
    for (const id of this.messageIds) {
      try { await setFeishuMessageReceipt(this.client, this.appId, id, state, this.signal); }
      catch (error) {
        this.signal.throwIfAborted();
        if (state !== "received") throw error;
        this.log?.(`Message receipt update failed: ${String(error)}`);
      }
    }
  }
}
