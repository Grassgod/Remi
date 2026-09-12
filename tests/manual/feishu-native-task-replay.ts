#!/usr/bin/env bun
/** Explicit opt-in live replay. The fixture stays outside git and contains
 * { snapshot: FeishuBotTaskSnapshot, messages: MultiremiTaskMessage[] }.
 * Uses the production presenter/serializers; lark-cli only supplies bot auth.
 * Never starts an Agent, executes a tool, or submits an approval.
 *
 * bun tests/manual/feishu-native-task-replay.ts --send --fixture /tmp/task.json
 *   --app-id cli_... --chat-id oc_... [--reply-to om_...] [--mention ou_...]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuBotTaskSnapshot, FeishuPresentationCheckpoint, MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const chatId = arg("--chat-id"), appId = arg("--app-id"), fixturePath = arg("--fixture");
if (!process.argv.includes("--send") || !chatId?.startsWith("oc_") || !appId || !fixturePath) {
  throw new Error("Explicit --send, --fixture, --app-id and --chat-id are required");
}
const cli = promisify(execFile);
const cliEnv = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
const auth = JSON.parse((await cli("lark-cli", ["auth", "status", "--json"], { env: cliEnv })).stdout);
if (auth.appId !== appId || !auth.identities?.bot?.available) throw new Error("Selected CLI bot differs from --app-id or is unavailable");
const fixture = await Bun.file(fixturePath).json() as { snapshot: FeishuBotTaskSnapshot; messages: MultiremiTaskMessage[] };
if (!["completed", "failed", "cancelled"].includes(fixture.snapshot.status)) throw new Error("Replay requires a terminal Task");
if (fixture.messages.some(m => ["permission_request", "question_request"].includes(m.type))) throw new Error("Use interaction unit tests for human requests; this replay never submits them");

const trace: Array<{ method: string; path: string; code: number; events?: string[] }> = [];
async function api(method: string, path: string, data: unknown, params?: unknown): Promise<any> {
  const args = ["api", method, path, "--as", "bot", ...(data === undefined ? [] : ["--data", JSON.stringify(data)]), ...(params ? ["--params", JSON.stringify(params)] : [])];
  let stdout: string;
  try { ({ stdout } = await cli("lark-cli", args, { env: cliEnv, maxBuffer: 2_000_000, timeout: 30_000 })); }
  catch (error) {
    // execFile errors include argv (message contents), so don't log the object.
    stdout = (error as { stdout?: string }).stdout ?? "";
    if (!stdout.trim().startsWith("{")) throw new Error(`${method} ${path}: CLI request failed`);
  }
  const raw = JSON.parse(stdout);
  const code = raw.ok === true ? 0 : Number(raw.code ?? raw.error?.code ?? -1);
  const events = (data as { events?: Array<{ event_type: string }> })?.events?.map(e => e.event_type);
  trace.push({ method, path, code, ...(events ? { events } : {}) });
  console.log(JSON.stringify(trace.at(-1)));
  return { code, data: raw.data, msg: "Live probe response" };
}

const client = {
  request: (request: any) => api(request.method, request.url, request.data, request.params),
  im: { message: {
    create: (request: any) => api("POST", "/open-apis/im/v1/messages", request.data, request.params),
    reply: (request: any) => api("POST", `/open-apis/im/v1/messages/${request.path.message_id}/reply`, request.data),
    patch: (request: any) => api("PATCH", `/open-apis/im/v1/messages/${request.path.message_id}`, request.data),
  } },
} as unknown as Lark.Client;
let saved: FeishuPresentationCheckpoint | undefined;
async function* stream(): AsyncGenerator<TaskStreamEvent> {
  for (const message of fixture.messages) {
    yield { kind: "message", message };
    if (message.type === "tool_result") await Bun.sleep(1000);
  }
  yield { kind: "snapshot", snapshot: fixture.snapshot };
}
const result = await new FeishuTaskPresentation(client, chatId, {
  taskId: fixture.snapshot.taskId,
  respondHumanRequest: async () => { throw new Error("Replay never submits a human response"); },
}, {
  appId, replyToMessageId: arg("--reply-to"), mentionOpenId: arg("--mention"),
  idempotencyKey: `manual-replay:${fixture.snapshot.taskId}:${Date.now()}`,
  save: async checkpoint => { saved = structuredClone(checkpoint); },
}).consume(stream());
if (saved?.cot?.status !== "finished" || trace.some(t => t.code !== 0)) throw new Error("Native CoT did not finish successfully");
console.log(JSON.stringify({ resultMessageId: result.messageId, cotId: saved.cot.cotId,
  cotMessageId: saved.cot.messageId, nativeWrites: trace.filter(t => t.method === "PUT").length,
  finalMessages: trace.filter(t => t.method === "POST" && !t.path.endsWith("message_cot")).length }));
