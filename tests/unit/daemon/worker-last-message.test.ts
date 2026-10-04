import { describe, expect, test } from "bun:test";
import { LastAssistantMessage } from "@multiremi/worker/last-assistant-message.js";

describe("task output's last assistant message", () => {
  test("joins chunks after top-level tools and ignores subagent text and tools", () => {
    const reply = new LastAssistantMessage();
    reply.push({ type: "text", content: "过程".repeat(100_000) });
    reply.push({ type: "tool_use" });
    reply.push({ type: "text", content: "child", meta: { parent_tool_call_id: "child" } });
    reply.push({ type: "tool_result" });
    reply.push({ type: "text", content: "C1" });
    reply.push({ type: "tool_use", meta: { parent_tool_call_id: "child" } });
    reply.push({ type: "text", content: "C2" });
    expect(reply.text).toBe("C1C2");
    reply.push({ type: "tool_use" });
    reply.push({ type: "tool_result" });
    expect(reply.text).toBe("C1C2");
  });

  test("prefers final phase, with compaction and steer boundaries", () => {
    const reply = new LastAssistantMessage();
    reply.push({ type: "text", content: "progress", meta: { phase: "commentary" } });
    reply.push({ type: "text", content: "final ", meta: { phase: "final" } });
    reply.push({ type: "text", content: "answer", meta: { phase: "final" } });
    reply.push({ type: "text", content: "more progress", meta: { phase: "commentary" } });
    expect(reply.text).toBe("final answer");
    reply.push({ type: "compaction" });
    expect(reply.text).toBe("final answer");
    reply.boundary();
    reply.push({ type: "text", content: "steered answer" });
    expect(reply.text).toBe("steered answer");
  });

  test("empty and child-only streams do not produce a result", () => {
    const reply = new LastAssistantMessage();
    reply.push({ type: "text", content: " ", meta: { phase: "final" } });
    reply.push({ type: "text", content: "child", meta: { parent_tool_call_id: "child" } });
    expect(reply.text).toBe("");
    expect(reply.result("child")).toBe("Task completed.");
    expect(new LastAssistantMessage().result("unstreamed reply")).toBe("unstreamed reply");
  });
});
