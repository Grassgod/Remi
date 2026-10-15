import { createHash } from "node:crypto";
import {
  isTraceEvent,
  TRACE_TOOL_ITEM_TYPES,
  type TraceAgentMessageItem,
  type TraceBackgroundTaskItem,
  type TraceCompactionItem,
  type TraceEvent,
  type TraceItem,
  type TraceNoticeItem,
  type TracePlanItem,
  type TraceSubagentItem,
  type TraceUserMessageItem,
} from "@multiremi/contracts/trace.js";
import { applyTurnTraceEvent, EMPTY_TURN_TRACE, finalItem, type TurnTraceState } from "@shared/turn-trace.js";
import {
  backgroundTaskResolver,
  isHiddenStep,
  subagentResolver,
  type AgentResolver,
  type BackgroundTaskResolver,
} from "@shared/trace-step-copy.js";
import { cotTextEvents, type CotSample } from "./native-cot.js";
import {
  cotBackgroundTaskRunning,
  cotBackgroundTaskStep,
  cotCompactionStep,
  cotDoorbellStep,
  cotPlan,
  cotStepRows,
  cotSubagentReady,
  cotSubagentStep,
  cotSubagentTitle,
  type CotListResult,
  type CotToolItem,
} from "./cot-tool-display.js";

/**
 * Items that end the final-reply rule's search for an `unknown`-phase answer
 * (rule 2 of `selectFinalReply`): any tool item, and a question, which Claude's
 * AskUserQuestion raises without a tool item. Reasoning, plans, compactions
 * and notices do not; neither does anything after a bridge-labelled `final`
 * (rule 1), which only a later final replaces.
 */
const RULE2_BLOCKERS: ReadonlySet<TraceItem["type"]> = new Set([...TRACE_TOOL_ITEM_TYPES, "question"]);
const ROW_TYPES: ReadonlySet<TraceItem["type"]> = new Set(["command", "file_change", "web_search", "tool"]);
/** What a written row's result says when its item later ends another way. */
const STATUS_NOTES: Partial<Record<TraceItem["status"], string>> = { failed: "执行失败", stopped: "已停止", declined: "已拒绝" };

interface OpenStep { stepId: string; kind: "subagent" | "compaction" | "background_task"; item: TraceItem }

/**
 * A replayable, presentation-only projection of a turn + items trace, folded
 * by the shared reducer. No tool execution, card building, or network calls
 * live here.
 *
 * Every native sample is a pure function of the event prefix, so replaying a
 * trace from seq 0 (as every presentation does) regenerates exactly the
 * samples a checkpoint acknowledged. Samples produced by events at or below
 * `throughSeq` are discarded; native IDs derive from item IDs, never timing.
 *
 * - Tool rows are written once, from `item.completed`, when the item is whole:
 *   one per command action, per changed file, else one, in Codex step copy.
 *   An agent-control row names its target from the trace's subagents
 *   (「已发送消息给 X」); a hidden step (Codex `wait`) writes no row, though it
 *   still ends the answer search like any tool.
 * - Text is written per item when it completes. A top-level agent message
 *   that may be the answer (`final` / `unknown` phase) is held, following the
 *   shared final-reply rule: a later message that would replace it, a rule-2
 *   blocker (tool or question) after an `unknown` one, or a steer (a new round)
 *   makes it narration. Steps that follow a held message (reasoning, plan,
 *   compaction, notice, and tools after a `final` one) wait behind it and are
 *   released after it, or, if it is the turn's final item, when the turn ends.
 * - The plan is redrawn from every snapshot whose entries changed; subagents
 *   and compactions are native steps from their start to their end.
 * - Background tasks (PR 6 §9): the call that started one is its launch row,
 *   always in the launch copy (「已启动后台命令 …」), and the task is a step
 *   from that row to its end: 「后台运行中：…」, then the shared copy of how
 *   it ended (a stop with its reason), or 「… 仍在后台运行」 when the attempt
 *   handed it off. A task seen while its call still runs opens its step after
 *   the call's row, or at the next event of another item. A doorbell turn
 *   (`user_message.background_tasks`) opens with 「后台任务 … 已完成」 per
 *   task, and the replayed end of a task it announced adds no second step.
 * - Nested items (`parent_id`) stay in the workbench.
 */
export class FeishuCotTimeline {
  private trace: TurnTraceState = EMPTY_TURN_TRACE;
  private queue: CotSample[] = [];
  private seq = 0;
  private replayDone = false;
  /** `REASONING_START` is queued (or handed to a waiting step). */
  private reasoning = false;
  /** The top-level agent message that may still be the final answer. */
  private held: string | null = null;
  /** Samples that followed the held message, in order. */
  private behind: CotSample[] = [];
  private readonly narrated = new Set<string>();
  /** Tool items already written: their last native call and the status it shows. */
  private readonly rows = new Map<string, { toolCallId: string; status: TraceItem["status"] }>();
  /** Subagents seen whose row waits for a real title, a child, or their end. */
  private readonly unopened = new Set<string>();
  private readonly steps = new Map<string, OpenStep>();
  private readonly finishedSteps = new Set<string>();
  private planFingerprint?: string;
  private readonly waiting = new Set<string>();
  /** Background task items whose step waits for the row of the call that started them, by call. */
  private readonly launching = new Map<string, Set<string>>();
  /** Task ids a doorbell of this attempt already reported as ended. */
  private readonly announced = new Set<string>();

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
    // A task waits for its call's row only while nothing else happens.
    if (!this.launching.has(item.id) && !(item.type === "background_task" && this.waitsForLaunch(item.id))) this.openLaunched();
    if (item.parent_id !== null) {
      // Nested prose and tools belong in the workbench; a child does show that
      // its subagent is running, title or not.
      if (this.unopened.has(item.parent_id)) {
        const parent = this.item(item.parent_id);
        if (parent?.type === "subagent") this.openSubagent(parent);
      }
      return;
    }
    if (!seen) {
      if (RULE2_BLOCKERS.has(item.type) && this.heldPhase() !== "final") this.release(true);
      // A steer starts a new round: the previous round's reply is now process text.
      if (item.type === "user_message" && item.origin === "steer") this.release(true);
    }
    const done = event.type === "item.completed";
    if (item.type === "agent_message") { if (done) this.message(item); }
    else if (item.type === "reasoning") { if (done) this.paragraph(item); }
    else if (ROW_TYPES.has(item.type)) { if (done && !isHiddenStep(item)) this.tool(item as CotToolItem); }
    else if (item.type === "subagent") this.subagent(item, done);
    else if (item.type === "compaction") this.compaction(item, seen, done);
    else if (item.type === "plan") this.plan(item, event.seq);
    else if (item.type === "notice" && !seen) this.notice(item);
    else if (item.type === "background_task") this.backgroundTask(item);
    else if (item.type === "user_message" && !seen) this.doorbells(item);
  }

  private item(id: string): TraceItem | undefined {
    return this.trace.items.find(candidate => candidate.id === id);
  }

  /** Names a control row's agent from the subagents seen so far; built only when a row asks. */
  private readonly resolveAgent: AgentResolver = target => subagentResolver(this.trace.items)(target);

  /**
   * The task a call started, for its row: always the launch, since a native
   * title cannot change later; the task's own step tells how it ends.
   */
  private readonly resolveLaunch: BackgroundTaskResolver = toolItemId => {
    const task = backgroundTaskResolver(this.trace.items)(toolItemId);
    return task && { ...task, phase: "active" };
  };

  private heldPhase(): TraceAgentMessageItem["phase"] | null {
    const held = this.held ? this.item(this.held) : undefined;
    return held?.type === "agent_message" ? held.phase : null;
  }

  private message(item: TraceAgentMessageItem): void {
    // A re-emitted message (the final-reply rule) changes only its phase.
    if (this.narrated.has(item.id) || this.held === item.id || !item.text.trim()) return;
    // The last `final` replaces an earlier one (rule 1); any later message
    // replaces or blocks an `unknown` one (rule 2).
    if (this.held && (this.heldPhase() !== "final" || item.phase === "final")) this.release(true);
    if (this.held || item.phase === "commentary") this.paragraph(item); // behind a `final`, any other message is process text
    else this.held = item.id;
  }

  /** Stop holding: write the held message as process text (unless it is the answer), then what waited behind it. */
  private release(narrate: boolean): void {
    const id = this.held;
    if (!id) return;
    this.held = null;
    const item = this.item(id);
    if (narrate && item?.type === "agent_message") this.paragraph(item);
    const behind = this.behind;
    this.behind = [];
    this.emit(behind);
  }

  /** Queue samples, or keep them behind a held message so the CoT stays in order. */
  private emit(samples: CotSample[]): void {
    if (this.held) { this.behind.push(...samples); return; }
    for (const sample of samples) {
      if (sample[0] === "REASONING_MESSAGE_START" && !this.reasoning) {
        this.queue.push(["REASONING_START", { messageId: this.id("reasoning") }]);
        this.reasoning = true;
      }
      this.queue.push(sample);
    }
  }

  private paragraph(item: { id: string; text: string }): void {
    if (this.narrated.has(item.id) || !item.text.trim()) return;
    this.narrated.add(item.id);
    this.emit(cotTextEvents(this.id(`text:${item.id}`), item.text, true));
  }

  private tool(item: CotToolItem): void {
    const written = this.rows.get(item.id);
    if (written) {
      // A later completion (a declined approval re-closes its tool) can only
      // add a result: an acknowledged native title cannot be rewritten.
      const note = STATUS_NOTES[item.status];
      if (note && item.status !== written.status && !this.resolveLaunch(item.id)) {
        written.status = item.status;
        this.emit([this.result(written.toolCallId, { type: "text", text: note }, `${item.id}:${item.status}`)]);
      }
      return;
    }
    const rows = cotStepRows(item, this.resolveAgent, this.resolveLaunch);
    const note = rows.at(-1)?.note;
    const samples: CotSample[] = [];
    let toolCallId = "";
    for (const row of rows) {
      toolCallId = this.id(`tool:${row.key}`);
      samples.push(["TOOL_CALL_START", { toolCallId, toolCallName: item.tool, title: row.title, icon: row.icon }]);
      if (row.args) samples.push(["TOOL_CALL_ARGS", { toolCallId, delta: row.args }]);
      // END closes the invocation display; the item itself is already complete.
      samples.push(["TOOL_CALL_END", { toolCallId }]);
    }
    if (note) samples.push(this.result(toolCallId, { type: "text", text: note }, `${item.id}:${item.status}`));
    this.emit(samples);
    this.rows.set(item.id, { toolCallId, status: item.status });
    // The tasks this call started open their steps right after its row.
    const launched = this.launching.get(item.id);
    this.launching.delete(item.id);
    for (const taskId of launched ?? []) this.openBackgroundTask(taskId);
  }

  /**
   * A top-level background task: a step from its first sight (or its call's
   * row) to its end. A level-closed task the bridge corrects later keeps its
   * first end, as a native step cannot be reopened.
   */
  private backgroundTask(item: TraceBackgroundTaskItem): void {
    if (this.finishedSteps.has(item.id)) return;
    if (!this.steps.has(item.id)) {
      if (this.waitsForLaunch(item.id)) return;
      const call = this.launchCall(item);
      if (call && call.parent_id === null && call.status === "in_progress" && ROW_TYPES.has(call.type) && !isHiddenStep(call)
        && !this.rows.has(call.id) && !this.announced.has(item.task_id)) {
        const waiting = this.launching.get(call.id) ?? new Set<string>();
        waiting.add(item.id);
        this.launching.set(call.id, waiting);
        return;
      }
      this.openBackgroundTask(item.id);
      return;
    }
    if (item.status !== "in_progress") this.finishStep(item.id, cotBackgroundTaskStep(item, this.launchCall(item)));
    else this.steps.set(item.id, { ...this.steps.get(item.id)!, item });
  }

  private waitsForLaunch(itemId: string): boolean {
    for (const waiting of this.launching.values()) if (waiting.has(itemId)) return true;
    return false;
  }

  /** Open every step still waiting for its call's row: something else happened first. */
  private openLaunched(): void {
    if (!this.launching.size) return;
    const waiting = [...this.launching.values()].flatMap(ids => [...ids]);
    this.launching.clear();
    for (const itemId of waiting) this.openBackgroundTask(itemId);
  }

  private launchCall(item: TraceBackgroundTaskItem): TraceItem | undefined {
    return item.tool_item_id ? this.item(item.tool_item_id) : undefined;
  }

  /** Open a task's step in its current state; one already ended finishes at once. */
  private openBackgroundTask(itemId: string): void {
    const item = this.item(itemId);
    if (item?.type !== "background_task" || this.steps.has(itemId) || this.finishedSteps.has(itemId)) return;
    // A doorbell rings only once its task ended, so any item of that task in
    // this attempt (its end replayed from the parked process) is that news again.
    if (this.announced.has(item.task_id)) {
      this.finishedSteps.add(item.id);
      return;
    }
    const stepId = this.id(`background:${item.id}`);
    const call = this.launchCall(item);
    this.emit([["STEP_STARTED", { stepId, stepName: cotBackgroundTaskRunning(item, call) }]]);
    this.steps.set(item.id, { stepId, kind: "background_task", item });
    if (item.status !== "in_progress") this.finishStep(item.id, cotBackgroundTaskStep(item, call));
  }

  /**
   * A doorbell turn's input (or a doorbell steer) says first why the agent
   * speaks (PR 6 §9), unless this attempt already showed that task's step.
   */
  private doorbells(item: TraceUserMessageItem): void {
    for (const doorbell of item.background_tasks ?? []) {
      const shown = this.trace.items.some(task => task.type === "background_task" && task.task_id === doorbell.task_id
        && (this.steps.has(task.id) || this.finishedSteps.has(task.id)));
      this.announced.add(doorbell.task_id);
      if (shown) continue;
      const stepId = this.id(`doorbell:${item.id}:${doorbell.task_id}`);
      const stepName = cotDoorbellStep(doorbell);
      this.emit([["STEP_STARTED", { stepId, stepName }], ["STEP_FINISHED", { stepId, stepName }]]);
    }
  }

  private subagent(item: TraceSubagentItem, done: boolean): void {
    // Claude's first frame carries only the "Task" / "Agent" placeholder; the
    // description and prompt follow in an update. Open on the first real one.
    if (!this.steps.has(item.id) && !this.finishedSteps.has(item.id)) {
      if (cotSubagentReady(item) || done) this.openSubagent(item);
      else this.unopened.add(item.id);
    }
    // A background subagent (`background: true`) stays in progress after its
    // launch is acknowledged and completes when the turn closes (spec §13), so
    // its completion is the child's real end, never the launch.
    if (done && this.steps.has(item.id)) this.finishStep(item.id, cotSubagentStep(item));
    else if (this.steps.has(item.id)) this.steps.set(item.id, { ...this.steps.get(item.id)!, item });
  }

  private openSubagent(item: TraceSubagentItem): void {
    this.unopened.delete(item.id);
    if (this.steps.has(item.id) || this.finishedSteps.has(item.id)) return;
    const stepId = this.id(`subagent:${item.id}`);
    const toolCallId = this.id(`tool:${item.id}`);
    this.emit([["TOOL_CALL_START", { toolCallId, toolCallName: item.tool, title: cotSubagentTitle(item), icon: "robot_outlined" }],
      ["TOOL_CALL_END", { toolCallId }],
      ["STEP_STARTED", { stepId, stepName: cotSubagentStep({ ...item, status: "in_progress" }) }]]);
    this.steps.set(item.id, { stepId, kind: "subagent", item });
  }

  private compaction(item: TraceCompactionItem, seen: boolean, done: boolean): void {
    const stepId = this.id(`compaction:${item.id}`);
    if (!seen) {
      // A compaction a bridge reports only once finished still opens its step.
      this.emit([["STEP_STARTED", { stepId, stepName: cotCompactionStep({ ...item, status: "in_progress" }) }]]);
      this.steps.set(item.id, { stepId, kind: "compaction", item });
    }
    if (done) this.finishStep(item.id, cotCompactionStep(item));
  }

  private finishStep(itemId: string, stepName: string): void {
    const step = this.steps.get(itemId);
    if (!step || this.finishedSteps.has(itemId)) return;
    this.steps.delete(itemId);
    this.finishedSteps.add(itemId);
    this.emit([["STEP_FINISHED", { stepId: step.stepId, stepName }]]);
  }

  private plan(item: TracePlanItem, seq: number): void {
    const plan = cotPlan(item.entries);
    const fingerprint = JSON.stringify(item.entries);
    // Closing the turn re-completes the plan unchanged; that is not a new step.
    if (!plan || fingerprint === this.planFingerprint) return;
    this.planFingerprint = fingerprint;
    const toolCallId = this.id(`plan:${item.id}:${seq}`);
    this.emit([["TOOL_CALL_START", { toolCallId, toolCallName: "Plan", icon: "doc", title: plan.title }],
      ["TOOL_CALL_END", { toolCallId }], this.result(toolCallId, plan.result, `plan:${seq}`)]);
  }

  private notice(item: TraceNoticeItem): void {
    const stepId = this.id(`notice:${item.id}`);
    this.emit([["STEP_STARTED", { stepId, stepName: item.title }], ["STEP_FINISHED", { stepId, stepName: item.title }]]);
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

  /** Close the display: the held message unless it is the answer, what waited behind it, open steps, the reasoning group. */
  finish(status: string): CotSample[] {
    const pending = this.drain().samples;
    const final = finalItem(this.trace.items, this.trace.turn?.final_item_id);
    this.release(this.held !== final?.id);
    this.openLaunched();
    // Finish display steps without claiming an unobserved background task succeeded.
    for (const [itemId, step] of [...this.steps]) {
      this.finishStep(itemId, step.kind === "compaction" ? cotCompactionStep({ ...(step.item as TraceCompactionItem), status: "stopped" })
        // A task still open was last seen running: it carries on in the background (spec §9).
        : step.kind === "background_task" ? cotBackgroundTaskStep(step.item as TraceBackgroundTaskItem,
          this.launchCall(step.item as TraceBackgroundTaskItem), "handed_off")
        : `${cotSubagentTitle(step.item as TraceSubagentItem)} · ${status === "cancelled" ? "本轮已中断" : "本轮已结束，子代理结果见工作台"}`);
    }
    if (this.reasoning) this.queue.push(["REASONING_END", { messageId: this.id("reasoning") }]);
    pending.push(...this.queue);
    this.queue = [];
    return pending;
  }
}
