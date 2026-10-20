import { describe, expect, it } from "vitest";
import type { AgentTask, RuntimeModel } from "@multiremi/core/types";
import { chatModelDisplay, runningChatTask } from "./chat-model";

const effort = { status: "supported" as const, supported_levels: [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] };
const models: RuntimeModel[] = [
  { id: "claude-opus-4-1", label: "Opus 4.1", thinking: effort },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", thinking: effort },
  { id: "bare-model", label: "bare-model" },
];
const task = (fields: Partial<AgentTask>): AgentTask => ({
  id: "att-1", turn_id: "turn-1", agent_id: "agent-1", runtime_id: null, issue_id: "", status: "running",
  priority: 0, dispatched_at: null, started_at: null, completed_at: null, result: null, error: null,
  created_at: "2026-10-20T00:00:00Z", chat_session_id: "chat-1", ...fields,
});

describe("chatModelDisplay", () => {
  it("names a set model by its catalog label", () => {
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1" }, models }))
      .toEqual({ modelId: "claude-opus-4-1", label: "Opus 4.1", effort: null, fallback: false });
  });

  it("keeps the raw id when the catalog does not know the model or gives no other name", () => {
    expect(chatModelDisplay({ agent: { model: "gpt-5-codex" }, models }).label).toBeNull();
    expect(chatModelDisplay({ agent: { model: "bare-model" }, models }).label).toBeNull();
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1" } })).toMatchObject({ modelId: "claude-opus-4-1", label: null });
  });

  it("adds the effort by the model's catalog label, else its raw token", () => {
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1", thinking_level: "high" }, models }).effort).toBe("High");
    expect(chatModelDisplay({ agent: { model: "gpt-5-codex", thinking_level: "xhigh" }, models }).effort).toBe("xhigh");
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1", thinking_level: "" }, models }).effort).toBeNull();
  });

  it("leaves the default model to the runtime, with the provider default's effort label", () => {
    for (const model of ["", "  ", "default", "auto"]) {
      expect(chatModelDisplay({ agent: { model }, models })).toEqual({ modelId: null, label: null, effort: null, fallback: false });
    }
    expect(chatModelDisplay({ agent: { model: "", thinking_level: "medium" }, models, defaultThinking: effort }).effort).toBe("Medium");
  });

  it("shows the fallback model a recovered running turn switched to, with its effort", () => {
    const switched = task({ fallback_switched: true, execution_model: "claude-sonnet-4-5", execution_thinking_level: "medium" });
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1", thinking_level: "high" }, models, runningTask: switched }))
      .toEqual({ modelId: "claude-sonnet-4-5", label: "Sonnet 4.5", effort: "Medium", fallback: true });
    // camelCase wire fields count the same.
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1" }, runningTask: task({ fallbackSwitched: true, executionModel: "gpt-5" }) }))
      .toMatchObject({ modelId: "gpt-5", fallback: true });
  });

  it("keeps the agent's model when the running turn did not switch", () => {
    // An execution override without the flag is not a fallback switch.
    const running = task({ execution_model: "claude-sonnet-4-5" });
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1" }, models, runningTask: running }))
      .toMatchObject({ modelId: "claude-opus-4-1", fallback: false });
    expect(chatModelDisplay({ agent: { model: "claude-opus-4-1" }, models, runningTask: task({ fallback_switched: true, execution_model: "" }) }))
      .toMatchObject({ modelId: "claude-opus-4-1", fallback: false });
  });
});

describe("runningChatTask", () => {
  const snapshot = [
    task({ id: "att-other", chat_session_id: "chat-2", turn_id: "turn-9" }),
    task({ id: "att-old", status: "failed" }),
    task({ id: "att-2", turn_id: "turn-1", fallback_switched: true }),
  ];

  it("finds the chat's active attempt by id, or by turn after a recovery replaced it", () => {
    expect(runningChatTask(snapshot, "chat-1", { task_id: "att-2", turn_id: "turn-1" })?.id).toBe("att-2");
    expect(runningChatTask(snapshot, "chat-1", { task_id: "att-old", turn_id: "turn-1" })?.id).toBe("att-2");
  });

  it("finds nothing without a pending task, a snapshot, or an active row of this chat", () => {
    expect(runningChatTask(snapshot, "chat-1", { supports_queue: true } as never)).toBeNull();
    expect(runningChatTask(undefined, "chat-1", { task_id: "att-2" })).toBeNull();
    expect(runningChatTask(snapshot, "chat-1", { task_id: "att-old" })).toBeNull();
    expect(runningChatTask(snapshot, "chat-3", { task_id: "att-other", turn_id: "turn-9" })).toBeNull();
    expect(runningChatTask(snapshot, null, { task_id: "att-2" })).toBeNull();
  });
});
