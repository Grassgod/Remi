#!/usr/bin/env bun
/** Opt-in native CoT experience, using production renderers and callbacks.
 * No provider runs, Task writes, deployments, or real tool/approval operations.
 * bun tests/manual/feishu-cot-experience.ts --send --app-id cli_... --chat-id oc_... --mention ou_...
 * Receives only callbacks for this replay's cards; unanswered demo requests
 * expire after 60s (never auto-approve). Stops only its own bounded consumer.
 * --replay-responses exercises labeled synthetic callbacks instead of opening
 * a competing event connection when the production bot already owns one.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuPresentationCheckpoint, MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import type { TraceEvent, TraceEventBody, TraceItem, TraceTurn, TraceTurnStatus } from "@multiremi/contracts/trace.js";
import { completeTurn } from "@shared/turn-trace.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { escapeCardText, handleTaskInteractionEvent } from "@connectors/feishu/task-interaction.js";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const chatId = arg("--chat-id"), appId = arg("--app-id"), recipient = arg("--mention");
const replayResponses = process.argv.includes("--replay-responses");
if (!process.argv.includes("--send") || !chatId?.startsWith("oc_") || !appId || !recipient?.startsWith("ou_")) {
  throw new Error("Explicit --send, --app-id, --chat-id and --mention required");
}
const cli = promisify(execFile);
const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
const auth = JSON.parse((await cli("lark-cli", ["auth", "status", "--json"], { env })).stdout);
if (auth.appId !== appId || !auth.identities?.bot?.available) throw new Error("CLI bot does not match --app-id");
const trace: Array<{ method: string; path: string; code: number; events?: string[] }> = [];
async function api(method: string, path: string, data?: any, params?: any): Promise<any> {
  let stdout = "";
  try { ({ stdout } = await cli("lark-cli", ["api", method, path, "--as", "bot",
    ...(data === undefined ? [] : ["--data", JSON.stringify(data)]), ...(params ? ["--params", JSON.stringify(params)] : [])],
  { env, maxBuffer: 2_000_000, timeout: 30_000 })); }
  catch (error) {
    // Never log execFile errors: their argv contains message contents.
    stdout = (error as { stdout?: string }).stdout ?? "";
    if (!stdout.trim().startsWith("{")) throw new Error(`${method} ${path}: CLI request failed`);
  }
  const raw = JSON.parse(stdout), code = raw.ok === true ? 0 : Number(raw.error?.code ?? raw.code ?? -1);
  const entry = { method, path, code, ...(data?.events ? { events: data.events.map((e: any) => e.event_type) } : {}) };
  trace.push(entry); console.log(JSON.stringify(entry));
  return { code, data: raw.data };
}
const verified = await api("GET", `/open-apis/im/v1/chats/${chatId}`, undefined, { user_id_type: "open_id" });
if (verified.code !== 0 || verified.data.chat_mode !== "p2p" || verified.data.owner_id !== recipient) {
  throw new Error("Demo requires the explicitly selected user's private chat");
}
const client = { request: (r: any) => api(r.method, r.url, r.data, r.params), im: { message: {
  create: (r: any) => api("POST", "/open-apis/im/v1/messages", r.data, r.params),
  reply: (r: any) => api("POST", `/open-apis/im/v1/messages/${r.path.message_id}/reply`, r.data),
  patch: (r: any) => api("PATCH", `/open-apis/im/v1/messages/${r.path.message_id}`, r.data),
} } } as unknown as Lark.Client;

const consumer = replayResponses ? null : spawn("lark-cli", ["event", "consume", "card.action.trigger", "--as", "bot", "--timeout", "6m",
  "--jq", `select(.chat_id == "${chatId}" and .operator_id == "${recipient}") | {chat_id,message_id,operator_id,action_name,action_tag,form_value}`],
{ env, stdio: ["ignore", "pipe", "pipe"] });
try {
  if (consumer) await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Callback consumer did not become ready")), 30_000);
    let diagnostic = "";
    consumer.stderr.on("data", chunk => {
      diagnostic += chunk;
      if (diagnostic.includes("[event] ready event_key=card.action.trigger")) { clearTimeout(timeout); resolve(); }
    });
    consumer.once("error", () => { clearTimeout(timeout); reject(new Error("Callback consumer failed to start")); });
    consumer.once("exit", code => { clearTimeout(timeout); if (code) reject(new Error(`Callback consumer exited: ${code}`)); });
  });
  console.log(replayResponses ? "Synthetic callback replay; no event connection opened" : "Callback consumer ready");
  const callbackIds = new Set<string>();
  const requestCards = new Map<string, string>();
  const requests = new Map<string, MultiremiTaskHumanRequest>();
  const lines = consumer ? createInterface({ input: consumer.stdout }) : null;
  let handling = Promise.resolve();
  lines?.on("line", line => { handling = handling.then(async () => {
    const event = JSON.parse(line);
    if (!callbackIds.has(event.message_id)) return;
    const result = await handleTaskInteractionEvent(appId, {
      operator: { open_id: event.operator_id }, context: { open_chat_id: event.chat_id, open_message_id: event.message_id },
      action: { name: event.action_name, tag: event.action_tag, ...(event.form_value ? { form_value: JSON.parse(event.form_value) } : {}) },
    });
    console.log(JSON.stringify({ callback: event.message_id, handled: Boolean(result) }));
  }).catch(() => { console.log("Demo callback could not be processed"); }); });

  const runId = `cot_experience_${Date.now()}`;
  // Turn + items events as the daemon's trace translator writes them.
  let seq = 0;
  let items: TraceItem[] = [];
  let current: TraceTurn | null = null;
  const now = () => new Date().toISOString();
  function emit(body: TraceEventBody): TaskStreamEvent {
    if (body.type.startsWith("item.") && "item" in body) {
      items = [...items.filter(row => row.id !== body.item.id), body.item];
    }
    return { kind: "message", message: { seq: ++seq, ts: now(), ...body } as TraceEvent };
  }
  function begin(taskId: string): TaskStreamEvent {
    items = [];
    current = { id: taskId, turn_id: null, agent_id: "demo_agent", agent_name: "Remi", provider: "claude", requested_model: null,
      model: "claude-fable-5-1", status: "running", error: null, started_at: now(), completed_at: null, duration_ms: null,
      final_item_id: null, final_started_at: null, context_usage: null,
      stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] } };
    return emit({ type: "turn.started", turn: current });
  }
  const end = (status: Exclude<TraceTurnStatus, "running">) =>
    emit({ type: "turn.completed", turn: completeTurn({ turn: current!, items }, { status, completedAt: now() })! });
  const base = (id: string) => ({ id, parent_id: null, status: "completed" as const, started_at: now(), completed_at: now() });
  const text = (id: string, value: string, phase: "commentary" | "final") =>
    emit({ type: "item.completed", item: { ...base(id), type: "agent_message", text: value, phase } });
  const plan = (entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>, first = false) =>
    emit({ type: first ? "item.started" : "item.updated", item: { ...base("plan"), status: "in_progress", completed_at: null,
      type: "plan", entries: entries.map(entry => ({ ...entry, priority: null })) } });
  const request = (item: TraceItem, done: boolean) =>
    emit({ type: done ? "item.completed" : "item.started", item: done ? item : { ...item, status: "in_progress", completed_at: null } });
  const outcomes: Array<{ taskId: string; cotMessageId?: string; resultMessageId: string; status?: string }> = [];
  async function run(suffix: string, stream: (taskId: string) => AsyncIterable<TaskStreamEvent>) {
    const taskId = `${runId}_${suffix}`;
    let saved: FeishuPresentationCheckpoint | undefined;
    const presenter = new FeishuTaskPresentation(client, chatId!, {
      taskId, displayName: "Remi", getHumanRequest: async id => {
        const r = requests.get(id);
        const cardId = requestCards.get(id);
        if (replayResponses && r?.status === "pending" && cardId && Date.now() - Date.parse(r.createdAt) > 10_000) {
          const { interactionMarker } = await import("@connectors/feishu/task-interaction.js");
          await handleTaskInteractionEvent(appId!, {
            operator: { open_id: recipient }, context: { open_chat_id: chatId, open_message_id: cardId },
            action: { tag: "button", name: `${interactionMarker(taskId, id)}${r.kind === "permission" ? "_o0" : ""}`,
              ...(r.kind === "question" ? { form_value: { q0_option0: true, q0_option1: true, q0_custom: "这是自动回放的演示答案", q1_option0: true } } : {}) },
          });
          console.log(JSON.stringify({ syntheticCallback: cardId }));
          return requests.get(id)!;
        }
        if (r?.status === "pending" && Date.now() - Date.parse(r.createdAt) > 60_000) {
          requests.set(id, { ...r, status: "timeout" });
        }
        return requests.get(id) ?? null;
      },
    }, { appId: appId!, mentionOpenId: recipient, idempotencyKey: taskId,
      save: async state => { saved = structuredClone(state); Object.entries(state.interactions).forEach(([id, e]) => {
        callbackIds.add(e.messageId); requestCards.set(id, e.messageId);
      }); } });
    const result = await presenter.consume(stream(taskId));
    const outcome = { taskId, cotMessageId: saved?.cot?.messageId, resultMessageId: result.messageId, status: saved?.cot?.status };
    outcomes.push(outcome); console.log(JSON.stringify(outcome));
    if (saved?.cot?.status !== "finished") throw new Error("Native demo process did not finish");
  }
  const snapshot = (taskId: string, status: "completed" | "failed" | "cancelled", started: string, error: string | null = null): TaskStreamEvent =>
    ({ kind: "snapshot", snapshot: { taskId, status, result: "", error, sessionId: "demo_only", workDir: null, usage: [],
      startedAt: started, completedAt: new Date().toISOString() } });
  async function* tool(row: TraceItem) {
    // Reproduce real ACP delivery: the item starts, then completes whole.
    yield emit({ type: "item.started", item: { ...row, status: "in_progress", completed_at: null } as TraceItem });
    await Bun.sleep(1200);
    yield emit({ type: "item.completed", item: row });
  }
  await run("full", async function* (taskId) {
    const started = new Date().toISOString();
    yield begin(taskId);
    yield text("msg:intro", "这是新版 CoT 的完整展示回放。任务内容、模型和上下文数字均为演示数据，不会执行真实工具或修改线上任务。先核对消息链路，再展示问答、审批和最终结果。" + (replayResponses ? "问答与审批将在 10 秒后自动回放模拟响应，无需点击，也不代表你的真实决定。" : ""), "commentary");
    yield plan([
      { content: "检查消息投递与工具展示", status: "in_progress" }, { content: "验证问答与审批衔接", status: "pending" },
      { content: "输出最终结果", status: "pending" },
    ], true);
    yield* tool({ ...base("skill"), type: "tool", tool: "Skill", server: null, kind: null, title: "Skill",
      input: { skill: "feishu-cot-review" }, output: "演示成功日志", duration_ms: 1200 });
    const path = "/demo/remi/packages/connectors/src/feishu/task-presentation.ts";
    yield* tool({ ...base("read"), type: "command", tool: "Read", source: "tool", command: null, cwd: null,
      actions: [{ type: "read", command: null, name: "task-presentation.ts", path }], output: null, exit_code: null, duration_ms: 1200 });
    yield* tool({ ...base("search"), type: "command", tool: "Bash", source: "shell", command: "rg 'message_cot' packages/connectors", cwd: null,
      actions: [{ type: "search", command: "rg 'message_cot' packages/connectors", query: "message_cot", path: "packages/connectors" }],
      output: '{"raw_log":"这段成功日志不应显示在 CoT 中"}', exit_code: 0, duration_ms: 1200 });
    yield text("msg:middle", "消息入口已核对。下面将子任务进度展示在同一条过程里，随后保留现有问答卡和审批卡交互。", "commentary");
    yield* tool({ ...base("child"), type: "subagent", tool: "Agent", title: "复核消息完成状态", prompt: null,
      output: "已完成演示复核", duration_ms: 1200 });
    yield plan([
      { content: "检查消息投递与工具展示", status: "completed" }, { content: "验证问答与审批衔接", status: "in_progress" },
      { content: "输出最终结果", status: "pending" },
    ]);
    const qId = `${taskId}_question`;
    requests.set(qId, { id: qId, taskId, kind: "question", status: "pending", response: null, respondedBy: null, respondedAt: null,
      createdAt: new Date().toISOString(), payload: { questions: [
        { question: replayResponses ? "本次展示重点看哪些部分？（自动演示，10 秒后回放答案，无需操作）" : "本次展示重点看哪些部分？（演示，可多选；60 秒未提交自动结束等待）", multiSelect: true,
          options: [{ label: "工具名称与图标" }, { label: "过程分组与待办" }, { label: "最终结果卡" }] },
        { question: "展示节奏是否合适？（演示，单选，也可以填写自定义回答）", multiSelect: false,
          options: [{ label: "合适" }, { label: "需要调整" }] },
      ] } });
    const questionItem: TraceItem = { ...base(`q:${qId}`), type: "question", tool_item_id: null, message: "演示问答", message_id: qId,
      questions: requests.get(qId)!.payload.questions as unknown[], answers: null, responded_by: null, reply_message_id: null };
    yield request(questionItem, false);
    yield request({ ...questionItem, status: requests.get(qId)?.status === "responded" ? "completed" : "stopped" }, true);
    yield text("msg:after-question", requests.get(qId)?.status === "responded"
      ? replayResponses ? "演示答案已回放，继续展示审批步骤。" : "已收到你提交的体验反馈，继续展示审批步骤。" : "问答演示等待已超时，未代填任何答案。继续展示下一种卡片。", "commentary");
    const pId = `${taskId}_permission`;
    requests.set(pId, { id: pId, taskId, kind: "permission", status: "pending", response: null, respondedBy: null, respondedAt: null,
      createdAt: new Date().toISOString(), payload: {
        tool_call: { title: replayResponses ? "审批效果演示：10 秒后自动回放「允许一次」，无需操作，不代表你的真实授权，也不会执行命令。" : "允许继续展示最终结果吗？（仅演示，不执行任何命令；60 秒未操作自动结束等待）", rawInput: {} },
        options: [{ optionId: "allow", name: "允许一次", kind: "allow_once" }, { optionId: "deny", name: "拒绝", kind: "reject_once" }],
      } });
    const permissionItem: TraceItem = { ...base(`perm:${pId}`), type: "permission", tool_item_id: null, title: "审批效果演示",
      message_id: pId, options: [{ option_id: "allow", name: "允许一次", kind: "allow_once" }, { option_id: "deny", name: "拒绝", kind: "reject_once" }],
      decision: null, outcome: null, responded_by: null, reply_message_id: null };
    yield request(permissionItem, false);
    yield request({ ...permissionItem, status: requests.get(pId)?.status === "responded" ? "completed" : "stopped" }, true);
    yield plan([
      { content: "检查消息投递与工具展示", status: "completed" }, { content: "展示问答与审批衔接", status: "completed" },
      { content: "输出最终结果", status: "completed" },
    ]);
    yield emit({ type: "turn.updated", patch: { context_usage: { used: 82000, size: 1000000 } } });
    const requestStatus = (id: string) => {
      const r = requests.get(id)!;
      if (r.status !== "responded") return "等待超时，未作答／未授权";
      const answers = r.response?.answers;
      const text = r.kind === "question" && answers && typeof answers === "object"
        ? Object.values(answers).map(value => String(value)).join("；")
        : r.response?.option_id === "allow" ? "允许一次" : "拒绝";
      return `${replayResponses ? "模拟回执（非用户决定）：" : ""}${escapeCardText(text)}`;
    };
    yield text("msg:answer", `**完整展示回放已结束。**\n\n原生过程消息负责按时间顺序展示文字、工具、待办和等待状态；最终答案独立放在这张结果卡里。\n\n| 检查项 | 本次效果 |\n| --- | --- |\n| 工具 | 描述、分类图标；成功日志不展开 |\n| 过程 | 多段文字与工具组按执行顺序排列 |\n| 交互 | 沿用原有问答／审批卡，提交后保留回执 |\n| 底部 | 完成后才显示 @、耗时、上下文、工具数 |\n\n问答：${requestStatus(qId)}\n\n审批：${requestStatus(pId)}\n\n接下来还有两条简短的失败／取消展示，分别检查错误收尾和中断状态。\n\n*本条为渲染验收演示；未调用模型、未执行真实工具、未变更线上任务。模型与上下文为示例，耗时为本次回放实际耗时。*`, "final");
    yield end("completed");
    yield snapshot(taskId, "completed", started);
  });
  for (const status of ["failed", "cancelled"] as const) await run(status, async function* (taskId) {
    const started = new Date().toISOString();
    yield begin(taskId);
    yield text("msg:intro", status === "failed" ? "失败场景演示：模拟工具返回错误，检查原生过程能否结束等待。" : "取消场景演示：模拟中断任务，检查过程状态与最终结果。", "commentary");
    const check: TraceItem = { ...base("check"), type: "command", tool: "Bash", source: "shell", command: "demo-check", cwd: null,
      actions: [{ type: "unknown", command: "demo-check" }], output: "演示错误原始日志，不应外显", exit_code: status === "failed" ? 1 : null, duration_ms: 1500 };
    yield emit({ type: "item.started", item: { ...check, status: "in_progress", completed_at: null, output: null } as TraceItem });
    await Bun.sleep(1500);
    yield emit({ type: "item.completed", item: { ...check, status: status === "failed" ? "failed" : "stopped" } as TraceItem });
    yield text("msg:answer", "本条为异常状态的展示验收，不代表线上任务失败或被取消。", "final");
    yield end(status);
    yield snapshot(taskId, status, started, status === "failed" ? "模拟工具错误（仅演示）" : null);
  });
  await handling;
  lines?.close();
  if (trace.some(t => t.code !== 0)) throw new Error("One or more live requests were rejected");
  console.log(JSON.stringify({ outcomes, callbackMode: replayResponses ? "synthetic" : "live", responses: [...requests.values()].filter(r => r.status === "responded").length,
    nativeWrites: trace.filter(t => t.method === "PUT").length, completeCalls: trace.filter(t => t.path.includes("/complete/")).length }));
} finally { consumer?.kill("SIGTERM"); }
