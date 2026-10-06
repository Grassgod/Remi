import { describe, expect, test } from "bun:test";
import { matchCancelledCodexTask, readCurrentTaskJsonPrefix, type CancelledCodexTask } from "../../../scripts/lib/native-trace-cancelled.js";
import { parseNativeRecords } from "../../../scripts/lib/native-trace-match.js";

const base = Date.parse("2026-10-05T22:00:00Z");
const at = (second: number) => new Date(base + second * 1000).toISOString();
const task: CancelledCodexTask = { id: "tsk_cancelled", provider: "codex", workspaceId: "w", runtimeId: "r", agentId: "a",
  nativeSessionId: "session", workDir: "/work", prompt: "perform this request", status: "cancelled", startedAt: null,
  createdAt: at(0), cancelledAt: at(600) };
const records = (values = sample()) => parseNativeRecords(values.map(v => JSON.stringify(v)).join("\n"));
function sample(): any[] {
  const item = (body: any, second: number) => ({ type: "event_msg", timestamp: at(second), payload: {
    type: "item_completed", thread_id: "session", turn_id: "turn", item: body,
    started_at_ms: base + (second - 1) * 1000, completed_at_ms: base + second * 1000,
  } });
  return [
    { type: "session_meta", timestamp: at(1), payload: { id: "session", cwd: "file:///work" } },
    { type: "event_msg", timestamp: at(2), payload: { type: "task_started", turn_id: "turn" } },
    { type: "response_item", timestamp: at(3), payload: { type: "message", role: "user", content: [{ text: "prefix perform this request suffix" }] } },
    item({ type: "UserMessage", id: "user", content: [{ text: "prefix perform this request suffix" }] }, 3),
    item({ type: "CommandExecution", id: "context", command: ["bash", "-lc", "remi context --output json"], status: "completed", exit_code: 0,
      aggregated_output: '{"task":{"id":"tsk_cancelled"},"long_description":"unfinished' }, 4),
    item({ type: "CommandExecution", id: "comment", command: ["bash", "-lc", "remi comment add issue --content-file report.md"], status: "completed", exit_code: 0,
      aggregated_output: JSON.stringify({ message: { taskId: task.id } }) }, 5),
    { type: "response_item", timestamp: at(6), payload: { type: "message", role: "assistant", content: [{ text: "native final" }] } },
    item({ type: "AgentMessage", id: "answer", content: [{ text: "native final" }] }, 6),
    { type: "event_msg", timestamp: at(7), payload: { type: "task_complete", turn_id: "turn", last_agent_message: "native final" } },
  ];
}

describe("cancelled task native proof", () => {
  test("requires unique database ownership plus two structured task ID witnesses", () => {
    const result = matchCancelledCodexTask(records(), task, [task.id]);
    expect(result.proof.method).toBe("cancelled-session-prompt-explicit-task-id-native-terminal");
    expect(result.proof.nativeStartedAt).toBe(at(2));
    expect(result.proof.explicitTaskWitnesses.map(w => w.kind)).toEqual(["remi-context-current-task", "remi-message-task-id"]);
    expect(result.proof.explicitTaskWitnesses[0]?.truncatedJsonSuffix).toBe(true);
    expect(task.startedAt).toBeNull();
    expect(task.status).toBe("cancelled");
  });
  test("accepts generated environment context before a unique prompt and the current context schema", () => {
    const rows = sample();
    rows[4].payload.item.aggregated_output = '{"current":{"task":{"id":"tsk_cancelled"}},"catalog":"unfinished';
    rows.splice(2, 0, { type: "response_item", timestamp: at(2), payload: { type: "message", role: "user", content: [{ text: "<environment_context>fixture</environment_context>" }] } });
    expect(matchCancelledCodexTask(records(rows), task, [task.id]).proof.explicitTaskWitnesses[0]?.path).toBe("current.task.id");
    rows[2].payload.content[0].text = "an unrelated instruction";
    expect(() => matchCancelledCodexTask(records(rows), task, [task.id])).toThrow("unverified_additional_user_input");
  });
  test("does not accept another owner, a failed task or a non-null server start", () => {
    expect(() => matchCancelledCodexTask(records(), task, [task.id, "other"])).toThrow("provider_session_not_uniquely_owned");
    expect(() => matchCancelledCodexTask(records(), { ...task, status: "failed" } as never, [task.id])).toThrow("cancelled_null_start_identity_required");
    expect(() => matchCancelledCodexTask(records(), { ...task, startedAt: at(2) } as never, [task.id])).toThrow("cancelled_null_start_identity_required");
  });
  test("rejects provider, workdir, prompt and task-context mismatches", () => {
    expect(() => matchCancelledCodexTask(records(), { ...task, nativeSessionId: "other" }, [task.id])).toThrow("native_session_mismatch");
    expect(() => matchCancelledCodexTask(records(), { ...task, workDir: "/other" }, [task.id])).toThrow("native_workdir_mismatch");
    expect(() => matchCancelledCodexTask(records(), { ...task, prompt: "different" }, [task.id])).toThrow("unique_prompt_anchor_required");
    const wrong = sample(); wrong[4].payload.item.aggregated_output = '{"task":{"id":"other"}}';
    expect(() => matchCancelledCodexTask(records(wrong), task, [task.id])).toThrow("context_current_task_mismatch");
  });
  test("rejects quoted IDs, list results, parent links and echoed fabricated context", () => {
    for (const value of [{ text: `task_id=${task.id}` }, { tasks: [{ id: task.id }] }, { parent_task_id: task.id }]) {
      const wrong = sample(); wrong[5].payload.item.aggregated_output = JSON.stringify(value);
      expect(() => matchCancelledCodexTask(records(wrong), task, [task.id])).toThrow("independent_structured_task_id_witnesses_required");
    }
    const echoed = sample(); echoed[4].payload.item.command[2] = 'echo "remi context"';
    expect(() => matchCancelledCodexTask(records(echoed), task, [task.id])).toThrow("independent_structured_task_id_witnesses_required");
  });
  test("requires full native start/end, final reply and item identities inside the cancellation interval", () => {
    expect(() => matchCancelledCodexTask(records(sample().slice(0, -1)), task, [task.id])).toThrow("exactly_one_complete_native_turn_required");
    expect(() => matchCancelledCodexTask(records(), { ...task, cancelledAt: at(5) }, [task.id])).toThrow("native_turn_outside_cancelled_task");
    const wrong = sample(); wrong[4].payload.turn_id = "another-turn";
    expect(() => matchCancelledCodexTask(records(wrong), task, [task.id])).toThrow("interleaved_native_turns");
    const wrongFinal = sample(); wrongFinal.at(-1).payload.last_agent_message = "different reply";
    expect(() => matchCancelledCodexTask(records(wrongFinal), task, [task.id])).toThrow("native_final_anchor_mismatch");
  });
});

describe("structured current-task JSON prefix", () => {
  test("retains only complete direct identity fields before a truncated suffix", () => {
    expect(readCurrentTaskJsonPrefix('{"task":{"id":"tsk_cancelled","description":"truncated'))
      .toEqual({ taskId: task.id, truncated: true });
    expect(readCurrentTaskJsonPrefix('{"task_id":"tsk_cancelled"}'))
      .toEqual({ rootTaskId: task.id, truncated: false });
    expect(readCurrentTaskJsonPrefix('{"text":"task.id=tsk_cancelled","history":[{"task":{"id":"other"}}]}'))
      .toEqual({ truncated: false });
  });
  test("rejects malformed syntax and duplicate fields after seeing an otherwise valid identity", () => {
    expect(readCurrentTaskJsonPrefix('{"task":{"id":"tsk_cancelled"},invalid}')).toBeNull();
    expect(readCurrentTaskJsonPrefix('{"task":{"id":"tsk_cancelled","id":"other"}}')).toBeNull();
    expect(readCurrentTaskJsonPrefix('{"task_id":"tsk_cancelled"} extra')).toBeNull();
    expect(readCurrentTaskJsonPrefix('{"task":{"id":"tsk_cancelled"},"invalid":xyz')).toBeNull();
    expect(readCurrentTaskJsonPrefix('not-json tsk_cancelled')).toBeNull();
  });
});
