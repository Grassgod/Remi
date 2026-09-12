import { createHash } from "node:crypto";
import type { MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import { cotTextEvents, type CotSample } from "./native-cot.js";
import { cotPlan, cotToolDisplay, isCotShell, isCotSubagent, type CotListResult } from "./cot-tool-display.js";

interface Tool {
  id: string; name: string; input: Record<string, unknown>; title?: string;
  hidden: boolean; queued: boolean; ended: boolean; firstSeen: number; step?: string;
}
const terminal = (status: string | null) => status === "completed" || status === "failed" || status === "cancelled";

/** A replayable, presentation-only projection of canonical Task messages.
 * No tool execution, card building, or network calls live here. */
export class FeishuCotTimeline {
  private readonly tools = new Map<string, Tool>();
  private queue: Array<CotSample | (() => CotSample[])> = [];
  private pendingTools = new Set<Tool>();
  private seq = 0;
  private replayDone = false;
  private candidate = "";
  private final = "";
  private reasoning = false;
  private openText?: string;
  private planFingerprint?: string;
  private readonly steps = new Map<string, string>();
  private readonly finishedSteps = new Set<string>();
  private readonly waiting = new Set<string>();

  constructor(private readonly taskId: string, private readonly throughSeq = 0, private readonly now = Date.now) {}
  private id(key: string): string { return createHash("sha256").update(`${this.taskId}:${key}`).digest("hex").slice(0, 32); }
  get toolCount(): number { return this.tools.size; }
  answer(fallback: string): string { return this.final.trim() || this.candidate.trim() || fallback.trim(); }

  accept(message: MultiremiTaskMessage): void {
    // Resolve deferred titles using only the acknowledged prefix, before any
    // fresh input can alter it. Reconstruct state, but never resend that prefix.
    if (!this.replayDone && message.seq > this.throughSeq) {
      this.drain(true);
      this.replayDone = true;
    }
    this.seq = message.seq;
    const nested = Boolean(message.meta?.parent_tool_call_id);
    if (nested) {
      if (message.type === "tool_use") this.recordTool(message, true);
      return; // nested prose/output belongs in the workbench, not the main CoT
    }
    if (message.type === "text") {
      if (message.meta?.phase === "final") { this.closeText(); this.final += message.content ?? ""; }
      else if (message.meta?.phase === "commentary") {
        if (this.candidate) { this.text(this.candidate, message.seq); this.candidate = ""; }
        this.text(message.content ?? "", message.seq);
      }
      else this.candidate += message.content ?? "";
      return;
    }
    if (["thinking", "tool_use", "permission_request", "question_request", "plan", "compaction"].includes(message.type)) {
      if (this.candidate) { this.text(this.candidate, message.seq); this.candidate = ""; }
    }
    if (message.type === "thinking") this.text(message.content ?? "", message.seq);
    else if (message.type === "tool_use") {
      this.closeText();
      const tool = this.recordTool(message, false);
      if (!tool.queued) {
        tool.queued = true;
        this.pendingTools.add(tool);
        this.queue.push(() => this.startTool(tool));
      }
      this.queue.push(() => this.childStates(tool.input));
    } else if (message.type === "tool_result") {
      this.closeText();
      const key = message.toolCallId ?? [...this.tools.keys()].findLast(k => !this.tools.get(k)!.ended);
      const tool = key ? this.tools.get(key) : undefined;
      if (!tool || tool.hidden || tool.ended) return;
      tool.input = { ...tool.input, ...message.input }; // terminal frames can carry the first real args
      if (message.meta?.title) tool.title = String(message.meta.title);
      if (message.status && !terminal(message.status)) return; // partial output is not completion
      tool.ended = true;
      const failed = message.status === "failed" || message.status === "cancelled";
      this.queue.push(() => {
        const events: CotSample[] = [];
        if (failed) events.push(this.result(tool.id, { type: "text", text: message.status === "cancelled" ? "已取消" : "执行失败" }, message.seq));
        else {
          const display = cotToolDisplay(tool.name, tool.input, tool.title);
          if (display.result) events.push(this.result(tool.id, display.result, message.seq));
        }
        // async_launched only acknowledges the launch, not the child outcome.
        events.push(...this.childStates(tool.input));
        if (tool.step && this.steps.has(tool.step) && !/async_launched|background_task_id/.test(message.output ?? "")
          && !Array.isArray(tool.input.receiverThreadIds)) {
          const title = this.steps.get(tool.step) ?? "子任务";
          events.push(["STEP_FINISHED", { stepId: tool.step, stepName: `${title} · ${failed ? "执行失败" : "已完成"}` }]);
          this.steps.delete(tool.step);
          this.finishedSteps.add(tool.step);
        }
        return events;
      });
    } else if (message.type === "plan") {
      this.closeText();
      const entries = message.meta?.entries;
      const plan = cotPlan(entries);
      const fingerprint = JSON.stringify(entries);
      if (plan && fingerprint !== this.planFingerprint) {
        this.planFingerprint = fingerprint;
        const toolCallId = this.id(`plan:${message.seq}`);
        this.queue.push(["TOOL_CALL_START", { toolCallId, toolCallName: "Plan", icon: "doc", title: plan.title }],
          ["TOOL_CALL_END", { toolCallId }], this.result(toolCallId, plan.result, message.seq));
      }
    } else if (message.type === "compaction") {
      this.closeText();
      const stepId = this.id(`compaction:${message.seq}`);
      this.queue.push(["STEP_STARTED", { stepId, stepName: "整理上下文" }],
        ["STEP_FINISHED", { stepId, stepName: "上下文已自动压缩" }]);
    } else if (message.type === "question_request" || message.type === "permission_request") {
      this.closeText();
    }
  }

  private recordTool(message: MultiremiTaskMessage, hidden: boolean): Tool {
    const key = message.toolCallId || `tool:${message.seq}`;
    let tool = this.tools.get(key);
    if (!tool) {
      tool = { id: this.id(key), name: message.tool || "Tool", input: {}, hidden, queued: false, ended: false, firstSeen: this.now() };
      this.tools.set(key, tool);
    }
    if (message.tool && !/^(unknown|tool|terminal)$/i.test(message.tool)) tool.name = message.tool;
    tool.input = { ...tool.input, ...message.input };
    if (message.meta?.title) tool.title = String(message.meta.title);
    return tool;
  }

  private startTool(tool: Tool): CotSample[] {
    const display = cotToolDisplay(tool.name, tool.input, tool.title);
    const events: CotSample[] = [["TOOL_CALL_START", { toolCallId: tool.id, toolCallName: tool.name,
      title: display.title, icon: display.icon }]];
    if (display.args) events.push(["TOOL_CALL_ARGS", { toolCallId: tool.id, delta: display.args }]);
    // END closes the invocation display, not the actual tool or child task.
    events.push(["TOOL_CALL_END", { toolCallId: tool.id }]);
    if (isCotSubagent(tool.name, tool.input)) {
      const receivers = Array.isArray(tool.input.receiverThreadIds) ? tool.input.receiverThreadIds : [];
      const ids = receivers.length ? receivers : [tool.input.agentThreadId || tool.id];
      for (const child of ids) {
        if (typeof child !== "string") continue;
        tool.step = this.id(`subagent:${child}`);
        const title = display.title.replace(/^启动子任务[:：]?/, "").trim() || "子任务";
        if (!this.steps.has(tool.step) && !this.finishedSteps.has(tool.step)) {
          this.steps.set(tool.step, title);
          events.push(["STEP_STARTED", { stepId: tool.step, stepName: title }]);
        }
      }
    }
    return events;
  }

  private childStates(input: Record<string, unknown>): CotSample[] {
    const states = input.agentsStates;
    if (!states || typeof states !== "object" || Array.isArray(states)) return [];
    const events: CotSample[] = [];
    for (const [child, value] of Object.entries(states)) {
      const status = value && typeof value === "object" ? (value as Record<string, unknown>).status : undefined;
      const stepId = this.id(`subagent:${child}`), title = this.steps.get(stepId);
      if (title && (status === "completed" || status === "errored" || status === "shutdown")) {
        events.push(["STEP_FINISHED", { stepId, stepName: `${title} · ${status === "completed" ? "已完成" : status === "errored" ? "执行失败" : "已停止"}` }]);
        this.steps.delete(stepId);
        this.finishedSteps.add(stepId);
      }
    }
    return events;
  }

  private text(text: string, seq: number): void {
    if (!text) return;
    if (!this.reasoning) { this.queue.push(["REASONING_START", { messageId: this.id("reasoning") }]); this.reasoning = true; }
    const opening = !this.openText;
    this.openText ??= this.id(`${seq}:reasoning`);
    const events = cotTextEvents(this.openText, text, true);
    this.queue.push(...events.slice(opening ? 0 : 1, -1));
  }
  private closeText(): void {
    if (this.openText) this.queue.push(["REASONING_MESSAGE_END", { messageId: this.openText }]);
    this.openText = undefined;
  }
  private result(toolCallId: string, content: CotListResult | { type: "text"; text: string }, seq: number): CotSample {
    return ["TOOL_CALL_RESULT", { toolCallId, messageId: this.id(`result:${seq}`), role: "tool",
      content: JSON.stringify(content) }];
  }

  waitForUser(requestId: string, kind: "question" | "permission", seq: number): CotSample[] {
    if (this.waiting.has(requestId)) return [];
    this.waiting.add(requestId);
    const events: CotSample[] = [["STEP_STARTED", { stepId: this.id(`waiting:${requestId}`),
      stepName: kind === "question" ? "等待用户回答" : "等待用户审批" }]];
    if (!this.reasoning) { events.push(["REASONING_START", { messageId: this.id("reasoning") }]); this.reasoning = true; }
    return [...events, ...cotTextEvents(this.id(`${seq}:waiting:${requestId}`),
      kind === "question" ? "等待你的回答，提交后继续。" : "等待你的审批，处理后继续。", true)];
  }
  resume(requestId: string, status: string): CotSample[] {
    this.waiting.delete(requestId);
    return [["STEP_FINISHED", { stepId: this.id(`waiting:${requestId}`),
      stepName: status === "responded" ? "已收到回复，继续执行" : status === "timeout" ? "等待回复已超时" : "等待回复已取消" }]];
  }

  /** No cursor advances past an unresolved placeholder; recovery can't skip its title. */
  drain(force = false): { samples: CotSample[]; throughSeq: number } {
    if (!force && [...this.pendingTools].some(t => !t.ended && this.now() - t.firstSeen < 1000
      && (Object.keys(t.input).every(k => k === "terminal_id") || (isCotShell(t.name) && !t.input.description)))) {
      return { samples: [], throughSeq: this.throughSeq };
    }
    const samples = this.queue.flatMap(item => typeof item === "function" ? item() : [item]);
    this.queue = [];
    this.pendingTools.clear();
    return { samples: this.seq <= this.throughSeq ? [] : samples, throughSeq: this.seq };
  }

  finish(status: string): CotSample[] {
    this.closeText();
    const pending = this.drain(true).samples;
    // Finish display steps without claiming an unobserved background task succeeded.
    for (const [stepId, title] of this.steps) pending.push(["STEP_FINISHED", { stepId,
      stepName: `${title} · ${status === "cancelled" ? "本轮已中断" : "本轮已结束，子任务结果见工作台"}` }]);
    this.steps.clear();
    if (this.reasoning) pending.push(["REASONING_END", { messageId: this.id("reasoning") }]);
    return pending;
  }
}
