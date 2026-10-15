import { describe, it, expect } from "vitest";
import { command, fileChange, message, read, reasoning, search, change, unknown, userMessage, webSearch } from "../../test/trace-fixtures";
import { pickStageKeys } from "./task-status-pill";

describe("pickStageKeys", () => {
  it("returns queued when status is queued and agent is online", () => {
    expect(pickStageKeys("queued", [], "online")).toEqual({ stageKey: "queued" });
  });

  it("returns offline when status is queued and agent is offline", () => {
    expect(pickStageKeys("queued", [], "offline")).toEqual({
      stageKey: "offline",
      static: true,
    });
  });

  it("returns waiting_local_directory on the daemon-emitted hold status", () => {
    // Daemon publishes this when it dequeues a task but another task owns the
    // local_directory's lock. The pill becomes static (no shimmer) because
    // nothing is actively happening from the user's point of view.
    expect(pickStageKeys("waiting_local_directory", [], "online")).toEqual({
      stageKey: "waiting_local_directory",
      static: true,
    });
  });

  it("waiting_local_directory wins over availability hints", () => {
    // Even if availability says reconnecting/offline, the directory-release
    // status is the more specific signal — surface it.
    expect(
      pickStageKeys("waiting_local_directory", [], "unstable"),
    ).toEqual({ stageKey: "waiting_local_directory", static: true });
    expect(
      pickStageKeys("waiting_local_directory", [], "offline"),
    ).toEqual({ stageKey: "waiting_local_directory", static: true });
  });

  it("returns awaiting_human as a static stage while a question waits for an answer", () => {
    // Agent is parked on a permission prompt / AskUserQuestion that climbs the
    // execution-owner chain; its summary line lives in HumanRequestDock.
    expect(pickStageKeys("awaiting_human", [], "online")).toEqual({
      stageKey: "awaiting_human",
      static: true,
    });
  });

  it("returns thinking for running with no messages", () => {
    expect(pickStageKeys("running", [], "online")).toEqual({ stageKey: "thinking" });
  });

  it("takes the running stage from the last top-level item", () => {
    const running = { status: "in_progress" as const, completed_at: null };
    expect(pickStageKeys("running", [userMessage("in:1", "hi")], "online")).toEqual({ stageKey: "thinking" });
    expect(pickStageKeys("running", [reasoning("rsn:1", "hm", running)], "online")).toEqual({ stageKey: "thinking" });
    expect(pickStageKeys("running", [message("msg:1", "Hel", "unknown", running)], "online")).toEqual({ stageKey: "typing" });
    expect(pickStageKeys("running", [command("cmd_1", [read("a.ts")], running)], "online"))
      .toEqual({ stageKey: "thinking", toolKey: "reading_files" });
    expect(pickStageKeys("running", [command("cmd_1", [search("x")], running)], "online"))
      .toEqual({ stageKey: "thinking", toolKey: "searching_code" });
    expect(pickStageKeys("running", [command("cmd_1", [read("a.ts"), unknown("make")], running)], "online"))
      .toEqual({ stageKey: "thinking", toolKey: "running_command" });
    expect(pickStageKeys("running", [fileChange("fc_1", [change("a.ts")], running)], "online"))
      .toEqual({ stageKey: "thinking", toolKey: "making_edits" });
    expect(pickStageKeys("running", [webSearch("ws_1", "q", running)], "online"))
      .toEqual({ stageKey: "thinking", toolKey: "searching_web" });
  });

  it("reads a finished tool as thinking again and ignores a subagent's own items", () => {
    expect(pickStageKeys("running", [command("cmd_1", [read("a.ts")])], "online")).toEqual({ stageKey: "thinking" });
    expect(pickStageKeys("running", [
      message("msg:1", "Hello", "unknown", { status: "in_progress", completed_at: null }),
      command("cmd_c", [unknown("make")], { parent_id: "agent_1", status: "in_progress", completed_at: null }),
    ], "online")).toEqual({ stageKey: "typing" });
  });
});
