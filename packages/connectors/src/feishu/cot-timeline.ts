import { createHash } from "node:crypto";
import {
  isTraceEvent,
  type TraceAgentMessageItem,
  type TraceCompactionItem,
  type TraceEvent,
  type TraceItem,
  type TraceNoticeItem,
  type TracePlanItem,
  type TraceSubagentItem,
} from "@multiremi/contracts/trace.js";
import { applyTurnTraceEvent, EMPTY_TURN_TRACE, finalItem, type TurnTraceState } from "@shared/turn-trace.js";
import { cotTextEvents, type CotSample } from "./native-cot.js";
import {
  cotCompactionStep,
  cotPlan,
  cotStepRows,
  cotSubagentStep,
  cotSubagentTitle,
  type CotListResult,
  type CotToolItem,
} from "./cot-tool-display.js";

/**
 * Item types whose first appearance ends the narration before them: an agent
 * message that may still be the answer becomes process text once a thought,
 * tool, plan, compaction or human request follows it.
 */
const NARRATION_BREAKS: ReadonlySet<TraceItem["type"]> = new Set([
  "reasoning", "command", "file_change", "web_search", "tool", "subagent", "plan", "compaction", "permission", "question",
]);
const ROW_TYPES: ReadonlySet<TraceItem["type"]> = new Set(["command", "file_change", "web_search", "tool"]);
/** What a written row's result says when its item later ends another way. */
const STATUS_NOTES: Partial<Record<TraceItem["status"], string>> = { failed: "执行失败", stopped: "已停止", declined: "已拒绝" };
/** An async subagent launch only acknowledges the child; its outcome is not in this turn. */
const BACKGROUND_LAUNCH = /async_launched|background_task_id/;

interface OpenStep { stepId: string; kind: "subagent" | "compaction"; item: TraceItem }

/**
 * A replayable, presentation-only projection of a turn + items trace, folded
 * by the shared reducer. No tool execution, card building, or network calls
 * live here.
 *
 * Every native sample is a pure function of the event prefix, so replaying a
 * trace from seq 0 regenerates exactly the samples a checkpoint acknowledged.
 * Samples produced by events at or below `throughSeq` are discarded; native
 * IDs derive from item IDs, never from timing.
 *
 * - Tool rows are written once, from `item.completed`, when the item is whole:
 *   one per command action, per changed file, else one, in Codex step copy.
 * - Text is written per item when it completes: reasoning and commentary at
 *   once; an agent message that may be the answer (`final` / `unknown` phase)
 *   is held until a later step proves it narration, or the turn ends and it
 *   is not the final item.
 * - The plan is redrawn from every snapshot whose entries changed; subagents
 *   and compactions are native steps from their start to their end.
 * - Nested items (`parent_id`) stay in the workbench.
 */
export class FeishuCotTimeline {
  private trace: TurnTraceState = EMPTY_TURN_TRACE;
  private queue: CotSample[] = [];
  private seq = 0;
  private replayDone = false;
  private reasoning = false;
  /** Top-level agent messages that may still be the final answer, in order. */
  private held: string[] = [];
  private readonly narrated = new Set<string>();
  /** Tool items already written: their last native call and the status it shows. */
  private readonly rows = new Map<string, { toolCallId: string; status: TraceItem["status"] }>();
  private readonly steps = new Map<string, OpenStep>();
  private readonly finishedSteps = new Set<string>();
  private planFingerprint?: string;
  private readonly waiting = new Set<string>();

  constructor(private readonly taskId: string, private readonly throughSeq = 0) {}
  private id(key: string): string { return createHash("sha256").update(`${this.taskId}:${key}`).digest("hex").slice(0, 32); }

  /** The folded trace (turn and items) at the last accepted event. */
  get state(): TurnTraceState { return this.trace; }

  /** The final reply's text, else the terminal snapshot's result. */
  answer(fallback: string): string {
    const final = finalItem(this.trace.items, this.trace.turn?.final_item_id);
    return final?.text.trim() || fallback.trim();
  }

  accept(event: TraceEvent): void {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq <= this.seq) return;
    // Rebuild state from the acknowledged prefix, but never resend it.
    if (!this.replayDone && event.seq > this.throughSeq) {
      this.queue = [];
      this.replayDone = true;
    }
    this.seq = event.seq;
    // A v1 line or an unknown event type advances the cursor and is otherwise
    // skipped, as by the shared reducer.
    if (!isTraceEvent(event)) return;
    const seen = event.type.startsWith("item.") && event.type !== "item.delta"
      && this.trace.items.some(item => item.id === (event as { item: TraceItem }).item.id);
    this.trace = applyTurnTraceEvent(this.trace, event);
    if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return;
    const item = event.item;
    if (item.parent_id !== null) return; // nested prose and tools belong in the workbench
    if (!seen && NARRATION_BREAKS.has(item.type)) this.narrate();
    const done = event.type === "item.completed";
    if (item.type === "agent_message") { if (done) this.message(item); }
    else if (item.type === "reasoning") { if (done) this.paragraph(item); }
    else if (ROW_TYPES.has(item.type)) { if (done) this.tool(item as CotToolItem); }
    else if (item.type === "subagent") this.subagent(item, seen, done);
    else if (item.type === "compaction") this.compaction(item, seen, done);
    else if (item.type === "plan") this.plan(item, event.seq);
    else if (item.type === "notice" && !seen) this.notice(item);
  }

  private message(item: TraceAgentMessageItem): void {
    // A re-emitted message (the final-reply rule) changes only its phase.
    if (this.narrated.has(item.id) || this.held.includes(item.id) || !item.text.trim()) return;
    // A later reply makes the earlier candidates narration: the last one wins.
    this.narrate();
    if (item.phase === "commentary") this.paragraph(item);
    else this.held.push(item.id);
  }

  /** Write the held candidates as process text, in order. */
  private narrate(): void {
    for (const id of this.held.splice(0)) {
      const item = this.trace.items.find(candidate => candidate.id === id);
      if (item?.type === "agent_message") this.paragraph(item);
    }
  }

  private paragraph(item: { id: string; text: string }): void {
    if (this.narrated.has(item.id) || !item.text.trim()) return;
    this.narrated.add(item.id);
    if (!this.reasoning) { this.queue.push(["REASONING_START", { messageId: this.id("reasoning") }]); this.reasoning = true; }
    this.queue.push(...cotTextEvents(this.id(`text:${item.id}`), item.text, true));
  }

  private tool(item: CotToolItem): void {
    const written = this.rows.get(item.id);
    if (written) {
      // A later completion (a declined approval re-closes its tool) can only
      // add a result: an acknowledged native title cannot be rewritten.
      const note = STATUS_NOTES[item.status];
      if (note && item.status !== written.status) {
        written.status = item.status;
        this.queue.push(this.result(written.toolCallId, { type: "text", text: note }, `${item.id}:${item.status}`));
      }
      return;
    }
    const rows = cotStepRows(item);
    const note = rows.at(-1)?.note;
    let toolCallId = "";
    for (const row of rows) {
      toolCallId = this.id(`tool:${row.key}`);
      this.queue.push(["TOOL_CALL_START", { toolCallId, toolCallName: item.tool, title: row.title, icon: row.icon }]);
      if (row.args) this.queue.push(["TOOL_CALL_ARGS", { toolCallId, delta: row.args }]);
      // END closes the invocation display; the item itself is already complete.
      this.queue.push(["TOOL_CALL_END", { toolCallId }]);
    }
    if (note) this.queue.push(this.result(toolCallId, { type: "text", text: note }, `${item.id}:${item.status}`));
    this.rows.set(item.id, { toolCallId, status: item.status });
  }

  /** A step opened before a resumed subscription's cursor was already written. */
  private acknowledged(seen: boolean, done: boolean): boolean {
    return !seen && done && this.throughSeq > 0;
  }

  private subagent(item: TraceSubagentItem, seen: boolean, done: boolean): void {
    const stepId = this.id(`subagent:${item.id}`);
    if (!seen) {
      if (!this.acknowledged(seen, done)) {
        const toolCallId = this.id(`tool:${item.id}`);
        this.queue.push(["TOOL_CALL_START", { toolCallId, toolCallName: item.tool, title: cotSubagentTitle(item), icon: "robot_outlined" }],
          ["TOOL_CALL_END", { toolCallId }],
          ["STEP_STARTED", { stepId, stepName: cotSubagentStep({ ...item, status: "in_progress" }) }]);
      }
      this.steps.set(item.id, { stepId, kind: "subagent", item });
    }
    if (done && this.steps.has(item.id) && !BACKGROUND_LAUNCH.test(item.output ?? "")) this.finishStep(item.id, cotSubagentStep(item));
    else if (this.steps.has(item.id)) this.steps.set(item.id, { stepId, kind: "subagent", item });
  }

  private compaction(item: TraceCompactionItem, seen: boolean, done: boolean): void {
    const stepId = this.id(`compaction:${item.id}`);
    if (!seen) {
      if (!this.acknowledged(seen, done)) {
        this.queue.push(["STEP_STARTED", { stepId, stepName: cotCompactionStep({ ...item, status: "in_progress" }) }]);
      }
      this.steps.set(item.id, { stepId, kind: "compaction", item });
    }
    if (done) this.finishStep(item.id, cotCompactionStep(item));
  }

  private finishStep(itemId: string, stepName: string): void {
    const step = this.steps.get(itemId);
    if (!step || this.finishedSteps.has(itemId)) return;
    this.steps.delete(itemId);
    this.finishedSteps.add(itemId);
    this.queue.push(["STEP_FINISHED", { stepId: step.stepId, stepName }]);
  }

  private plan(item: TracePlanItem, seq: number): void {
    const plan = cotPlan(item.entries);
    const fingerprint = JSON.stringify(item.entries);
    // Closing the turn re-completes the plan unchanged; that is not a new step.
    if (!plan || fingerprint === this.planFingerprint) return;
    this.planFingerprint = fingerprint;
    this.narrate();
    const toolCallId = this.id(`plan:${item.id}:${seq}`);
    this.queue.push(["TOOL_CALL_START", { toolCallId, toolCallName: "Plan", icon: "doc", title: plan.title }],
      ["TOOL_CALL_END", { toolCallId }], this.result(toolCallId, plan.result, `plan:${seq}`));
  }

  private notice(item: TraceNoticeItem): void {
    const stepId = this.id(`notice:${item.id}`);
    this.queue.push(["STEP_STARTED", { stepId, stepName: item.title }], ["STEP_FINISHED", { stepId, stepName: item.title }]);
  }

  private result(toolCallId: string, content: CotListResult | { type: "text"; text: string }, key: string): CotSample {
    return ["TOOL_CALL_RESULT", { toolCallId, messageId: this.id(`result:${key}`), role: "tool",
      content: JSON.stringify(content) }];
  }

  waitForUser(requestId: string, kind: "question" | "permission"): CotSample[] {
    if (this.waiting.has(requestId)) return [];
    this.waiting.add(requestId);
    const events: CotSample[] = [["STEP_STARTED", { stepId: this.id(`waiting:${requestId}`),
      stepName: kind === "question" ? "等待用户回答" : "等待用户审批" }]];
    if (!this.reasoning) { events.push(["REASONING_START", { messageId: this.id("reasoning") }]); this.reasoning = true; }
    return [...events, ...cotTextEvents(this.id(`waiting-text:${requestId}`),
      kind === "question" ? "等待你的回答，提交后继续。" : "等待你的审批，处理后继续。", true)];
  }
  resume(requestId: string, status: string): CotSample[] {
    this.waiting.delete(requestId);
    return [["STEP_FINISHED", { stepId: this.id(`waiting:${requestId}`),
      stepName: status === "responded" ? "已收到回复，继续执行" : status === "timeout" ? "等待回复已超时" : "等待回复已取消" }]];
  }

  /** Samples since the last drain, and the seq they are acknowledged through. */
  drain(): { samples: CotSample[]; throughSeq: number } {
    const samples = this.queue;
    this.queue = [];
    return { samples: this.seq <= this.throughSeq ? [] : samples, throughSeq: this.seq };
  }

  /** Close the display: held narration that is not the answer, open steps, then the reasoning group. */
  finish(status: string): CotSample[] {
    const pending = this.drain().samples;
    const final = finalItem(this.trace.items, this.trace.turn?.final_item_id);
    for (const id of this.held.splice(0)) {
      const item = this.trace.items.find(candidate => candidate.id === id);
      if (item?.type === "agent_message" && item.id !== final?.id) this.paragraph(item);
    }
    // Finish display steps without claiming an unobserved background task succeeded.
    for (const [itemId, step] of [...this.steps]) {
      this.finishStep(itemId, step.kind === "compaction" ? cotCompactionStep({ ...(step.item as TraceCompactionItem), status: "stopped" })
        : `${cotSubagentTitle(step.item as TraceSubagentItem)} · ${status === "cancelled" ? "本轮已中断" : "本轮已结束，子任务结果见工作台"}`);
    }
    if (this.reasoning) this.queue.push(["REASONING_END", { messageId: this.id("reasoning") }]);
    pending.push(...this.queue);
    this.queue = [];
    return pending;
  }
}
