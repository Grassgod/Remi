import type { TaskMessageInput } from "@multiremi/contracts/types.js";

/** Trace keeps the full transcript; task output keeps the last top-level reply. */
export class LastAssistantMessage {
  private segment = "";
  private finalSegment = "";
  private lastSegment = "";

  push(message: TaskMessageInput): void {
    if (message.meta?.parent_tool_call_id) return;
    if (message.type === "text") {
      this.segment += message.content ?? "";
      if (message.meta?.phase === "final") this.finalSegment += message.content ?? "";
    } else if (["tool_use", "tool_result", "compaction"].includes(message.type)) {
      this.boundary();
    }
  }

  boundary(): void {
    const text = (this.finalSegment.trim() || this.segment.trim());
    if (text) this.lastSegment = text;
    this.segment = "";
    this.finalSegment = "";
  }

  get text(): string {
    return this.finalSegment.trim() || this.segment.trim() || this.lastSegment;
  }
}
