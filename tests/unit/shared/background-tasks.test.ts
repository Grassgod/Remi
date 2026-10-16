import { describe, expect, it } from "bun:test";
import {
  BACKGROUND_LANE_RELEASE_REASONS,
  BACKGROUND_LANE_STATES,
  BACKGROUND_TASK_LIVE_STATUSES,
  BACKGROUND_TASK_STATUSES,
  BACKGROUND_TASK_STOP_REASONS,
  type BackgroundTaskDoorbellMetadata,
} from "@multiremi/contracts/unified-model";
import {
  BACKGROUND_KEEPALIVE_MIN_MS,
  BACKGROUND_KEEPALIVE_MS,
  BACKGROUND_PARK_WITHOUT_WAKE,
  BACKGROUND_STOP_ALL_CONFIRM_MIN,
  backgroundDoorbellBody,
  backgroundDoorbellDedupeKey,
  backgroundFolderHolderForDisplay,
  backgroundFolderHolderNote,
  backgroundParkedUntil,
  confirmsBackgroundStop,
  formatBackgroundDuration,
  isEndedBackgroundTaskStatus,
  isLiveBackgroundTaskStatus,
  parksBackgroundTasks,
  readBackgroundDoorbell,
  readBackgroundFolderHolder,
  resolveBackgroundKeepAliveMs,
  ringsBackgroundDoorbell,
} from "@shared/background-tasks.js";

// PR 6 rules shared by the daemon, the server, the web and Feishu.

const claude = { wakesModel: true };
const codex = { wakesModel: false };

describe("U1: keep-alive cap", () => {
  it("defaults to 2 hours, measured from the lane's latest attempt end", () => {
    expect(BACKGROUND_KEEPALIVE_MS).toBe(2 * 60 * 60 * 1000);
    expect(backgroundParkedUntil(1_000)).toBe(1_000 + BACKGROUND_KEEPALIVE_MS);
    // A later attempt end moves it.
    expect(backgroundParkedUntil(5_000, 60_000)).toBe(65_000);
  });

  it("takes a whole-millisecond override and falls back on anything else", () => {
    expect(resolveBackgroundKeepAliveMs("60000")).toBe(60_000);
    expect(resolveBackgroundKeepAliveMs(" 90000 ")).toBe(90_000);
    expect(resolveBackgroundKeepAliveMs(120_000)).toBe(120_000);
    expect(resolveBackgroundKeepAliveMs(String(BACKGROUND_KEEPALIVE_MIN_MS))).toBe(BACKGROUND_KEEPALIVE_MIN_MS);
    for (const raw of [undefined, null, "", "0", "-5", "1.5", "2h", "999", 0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(resolveBackgroundKeepAliveMs(raw), String(raw)).toBe(BACKGROUND_KEEPALIVE_MS);
    }
  });
});

describe("U2: who parks, who rings", () => {
  it("parks every bridge that publishes tasks, Codex included (default A)", () => {
    expect(BACKGROUND_PARK_WITHOUT_WAKE).toBe(true);
    expect(parksBackgroundTasks(claude)).toBe(true);
    expect(parksBackgroundTasks(codex)).toBe(true);
    expect(parksBackgroundTasks(undefined)).toBe(false);
    expect(parksBackgroundTasks(null)).toBe(false);
  });

  it("rings only for a waking bridge's completed or failed task, never for a stop", () => {
    expect(ringsBackgroundDoorbell(claude, "completed")).toBe(true);
    expect(ringsBackgroundDoorbell(claude, "failed")).toBe(true);
    for (const status of ["running", "paused", "stopped", "unknown"] as const) expect(ringsBackgroundDoorbell(claude, status)).toBe(false);
    for (const status of BACKGROUND_TASK_STATUSES) expect(ringsBackgroundDoorbell(codex, status)).toBe(false);
    expect(ringsBackgroundDoorbell(undefined, "completed")).toBe(false);
  });
});

describe("U3: stop confirmation", () => {
  it("never asks for one task; asks for 「全部停止」 of 2 or more (default A)", () => {
    expect(BACKGROUND_STOP_ALL_CONFIRM_MIN).toBe(2);
    expect(confirmsBackgroundStop({ all: false, count: 1 })).toBe(false);
    expect(confirmsBackgroundStop({ all: false, count: 5 })).toBe(false);
    expect(confirmsBackgroundStop({ all: true, count: 1 })).toBe(false);
    expect(confirmsBackgroundStop({ all: true, count: 2 })).toBe(true);
    expect(confirmsBackgroundStop({ all: true, count: 9 })).toBe(true);
  });
});

describe("registry vocabulary", () => {
  it("splits statuses into live, ended and unknown", () => {
    expect(BACKGROUND_TASK_STATUSES.filter(isLiveBackgroundTaskStatus)).toEqual([...BACKGROUND_TASK_LIVE_STATUSES]);
    expect(BACKGROUND_TASK_STATUSES.filter(isEndedBackgroundTaskStatus)).toEqual(["completed", "failed", "stopped"]);
    expect(isLiveBackgroundTaskStatus("unknown") || isEndedBackgroundTaskStatus("unknown")).toBe(false);
  });

  it("keeps the stop reasons unique, with every release reason among them", () => {
    expect(new Set(BACKGROUND_TASK_STOP_REASONS).size).toBe(BACKGROUND_TASK_STOP_REASONS.length);
    for (const reason of BACKGROUND_LANE_RELEASE_REASONS) expect(BACKGROUND_TASK_STOP_REASONS as readonly string[]).toContain(reason);
    expect([...BACKGROUND_LANE_STATES]).toEqual(["in_attempt", "parked", "closed"]);
  });
});

describe("doorbell (§2.5)", () => {
  const doorbell: BackgroundTaskDoorbellMetadata = {
    task_id: "bsh_1", name: "npm test", task_type: "shell", status: "completed", origin_attempt_id: "tsk_1",
    origin_turn_id: "turn_1", provider_session_id: "sess_1",
  };

  it("deduplicates per agent, scope and task", () => {
    expect(backgroundDoorbellDedupeKey({ agent_id: "agt_1", execution_scope: "default" }, "bsh_1")).toBe("bg:agt_1:default:bsh_1");
  });

  it("formats durations the way the doorbell reads them", () => {
    expect(formatBackgroundDuration(0)).toBe("0 秒");
    expect(formatBackgroundDuration(44_600)).toBe("45 秒");
    expect(formatBackgroundDuration(60_000)).toBe("1 分");
    expect(formatBackgroundDuration(125_000)).toBe("2 分 5 秒");
    expect(formatBackgroundDuration(3_600_000)).toBe("1 小时");
    expect(formatBackgroundDuration(3_780_000)).toBe("1 小时 3 分");
    expect(formatBackgroundDuration(-5)).toBe("0 秒");
  });

  it("writes the body with the outcome, the duration when known and the summary", () => {
    expect(backgroundDoorbellBody({ name: "npm test", status: "completed", duration_ms: 125_000, summary: "  42 passed  " }))
      .toBe("后台任务已结束：npm test（已完成，用时 2 分 5 秒）\n42 passed");
    expect(backgroundDoorbellBody({ name: "npm test", status: "failed" })).toBe("后台任务已结束：npm test（失败）");
    expect(backgroundDoorbellBody({ name: " ", status: "completed", duration_ms: null, summary: "" })).toBe("后台任务已结束：后台任务（已完成）");
  });

  it("reads a well-formed doorbell from message metadata and nothing else", () => {
    expect(readBackgroundDoorbell({ background_task: doorbell, other: 1 })).toEqual(doorbell);
    expect(readBackgroundDoorbell({ background_task: { ...doorbell, origin_turn_id: undefined } })).toEqual({ ...doorbell, origin_turn_id: null });
    expect(readBackgroundDoorbell({ background_task: { ...doorbell, extra: true } })).toEqual(doorbell);
    for (const metadata of [
      null, undefined, "x", [], {}, { background_task: null }, { background_task: [] },
      { background_task: { ...doorbell, status: "stopped" } },
      { background_task: { ...doorbell, task_id: "" } },
      { background_task: { ...doorbell, name: 3 } },
      { background_task: { ...doorbell, origin_attempt_id: null } },
      { background_task: { ...doorbell, provider_session_id: "" } },
      { background_task: { ...doorbell, origin_turn_id: 7 } },
    ]) expect(readBackgroundDoorbell(metadata), JSON.stringify(metadata)).toBeNull();
  });
});

describe("shared local folders (§2.8)", () => {
  it("names a parked lane's chat in the waiting reason, and reads it back", () => {
    const note = backgroundFolderHolderNote("chat_ab12cd34");
    expect(note).toBe("held by background tasks of chat chat_ab12cd34");
    for (const reason of [
      `local_directory /Users/me/repo (${note})`,
      `Runtime workspace is busy (${note})`,
      note,
    ]) expect(readBackgroundFolderHolder(reason), reason).toEqual({ session_id: "chat_ab12cd34" });
    // Only the note that closes the reason counts, not words in the folder's path.
    expect(readBackgroundFolderHolder(`local_directory /tmp/held by background tasks of chat x (${note})`))
      .toEqual({ session_id: "chat_ab12cd34" });
    expect(readBackgroundFolderHolder("local_directory /tmp/(held by background tasks of chat x) (held by task tsk_abcd)")).toBeNull();
  });

  it("shows people the holder without its chat id", () => {
    const note = backgroundFolderHolderNote("chat_ab12cd34");
    expect(backgroundFolderHolderForDisplay(`local_directory /Users/me/repo (${note})`))
      .toBe("local_directory /Users/me/repo (held by another chat's background tasks)");
    expect(backgroundFolderHolderForDisplay(`Runtime workspace is busy (${note})`))
      .toBe("Runtime workspace is busy (held by another chat's background tasks)");
    expect(backgroundFolderHolderForDisplay(note)).toBe("held by another chat's background tasks");
    for (const reason of ["local_directory /Users/me/repo (held by task tsk_abcd)", "Runtime workspace is busy (process 4242)"]) {
      expect(backgroundFolderHolderForDisplay(reason)).toBe(reason);
    }
  });

  it("reads nothing from any other reason", () => {
    for (const reason of [
      null, undefined, 3, {}, "", "local_directory /Users/me/repo", "local_directory /Users/me/repo (held by task tsk_abcd)",
      "Runtime workspace is busy (process 4242)", "held by background tasks of chat ", "held by background tasks of chat (x)",
    ]) expect(readBackgroundFolderHolder(reason), String(reason)).toBeNull();
  });
});
