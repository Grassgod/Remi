import type { TaskStreamEvent } from "@connectors/base.js";
import type { FeishuPresentationCheckpoint } from "@multiremi/contracts/types.js";

export function taskEvent(seq: number, type: string, patch: Record<string, unknown> = {}): TaskStreamEvent {
  return { kind: "message", message: { id: `msg_${seq}`, taskId: "tsk_test", seq, type, tool: null, content: null,
    input: null, output: null, toolCallId: null, status: null, meta: null, createdAt: new Date().toISOString(), ...patch } } as TaskStreamEvent;
}
export const completed: TaskStreamEvent = { kind: "snapshot", snapshot: { taskId: "tsk_test", status: "completed",
  result: "Final answer", error: null, sessionId: "session_original", workDir: "/test", usage: [] } };
export async function* transcript() {
  yield taskEvent(1, "execution", { meta: { agentName: "Remi", provider: "claude", model: "claude-fable-5-1" } });
  yield taskEvent(2, "text", { content: "I will inspect the source." });
  yield taskEvent(3, "tool_use", { tool: "Read", toolCallId: "tc_1" });
  yield taskEvent(4, "tool_use", { tool: "Read", toolCallId: "tc_1", input: { file_path: "/source.ts" } });
  yield taskEvent(5, "tool_result", { toolCallId: "tc_1", output: "source", status: "completed" });
  yield taskEvent(6, "text", { content: "Final answer" });
  yield taskEvent(7, "usage", { meta: { used: 82000, size: 1000000 } });
  yield completed;
}

export function nativeHarness() {
  const calls: Array<{ operation: string; input: any }> = [];
  const uuids = new Map<string, string>();
  let nextId = 0;
  const send = async (operation: string, input: any) => {
    calls.push({ operation, input });
    const key = input.data.uuid ?? `new_${nextId}`;
    if (!uuids.has(key)) uuids.set(key, `om_${++nextId}`);
    return { code: 0, data: { message_id: uuids.get(key) } };
  };
  const client = {
    request: async (input: any) => { calls.push({ operation: input.method, input });
      return { code: 0, data: input.method === "POST" ? { cot_id: "cot_1", message_id: "om_cot" } : {} }; },
    im: { message: {
      create: (input: any) => send("create", input), reply: (input: any) => send("reply", input),
      patch: async (input: any) => { calls.push({ operation: "patch", input }); return { code: 0 }; },
    } },
  };
  let checkpoint: FeishuPresentationCheckpoint | undefined;
  return { client, calls, uuids,
    get checkpoint() { return checkpoint; },
    save: async (p: FeishuPresentationCheckpoint) => { checkpoint = structuredClone(p); },
    events: () => calls.filter(c => c.operation === "PUT").flatMap(c => c.input.data.events),
    cards: () => calls.filter(c => ["create", "reply", "patch"].includes(c.operation)).map(c => JSON.parse(c.input.data.content)),
  };
}
