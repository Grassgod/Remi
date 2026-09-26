import { describe, expect, it } from "bun:test";
import {
  DAEMON_ACK_TIMEOUT_MS,
  DAEMON_DOWNLINK_EVENT_FRAMES,
  DAEMON_DOWNLINK_RPC_FRAMES,
  DAEMON_DOWNLINK_TRACE_FRAMES,
  DAEMON_FRAME_MAX_BYTES,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_MIN_CLI_VERSION,
  DAEMON_OFFER_COOLDOWN_MS,
  DAEMON_OFFER_TIMEOUT_MS,
  DAEMON_PROTOCOL_CAPS,
  DAEMON_PROTOCOL_CLOSE_CODES,
  DAEMON_PROTOCOL_ERROR_CODES,
  DAEMON_PROTOCOL_MIN,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RETRYABLE_ERROR_CODES,
  DAEMON_TERMINAL_ERROR_CODES,
  DAEMON_TRACE_READ_MAX_LIMIT,
  DAEMON_UPLINK_EVENT_FRAMES,
  DAEMON_UPLINK_BEST_EFFORT_FRAMES,
  DAEMON_UPLINK_RPC_FRAMES,
  DAEMON_UPLINK_TRACE_FRAMES,
  DAEMON_UPLINK_WINDOW_FRAMES,
  DAEMON_WS_MAX_PAYLOAD_BYTES,
  compareDaemonCliVersion,
  daemonCloseCodeIsRetryable,
  daemonFrameCategory,
  daemonFrameIsReliable,
  daemonFrameUsesOutboxWindow,
  daemonFrameUsesSeq,
  meetsDaemonMinCliVersion,
} from "@multiremi/contracts/daemon-protocol.js";

/** Every frame name the protocol defines, in one list, so the inventory cannot silently shrink. */
const ALL_FRAME_NAMES = [
  ...DAEMON_UPLINK_EVENT_FRAMES,
  ...DAEMON_UPLINK_TRACE_FRAMES,
  ...DAEMON_UPLINK_BEST_EFFORT_FRAMES,
  ...DAEMON_UPLINK_RPC_FRAMES,
  ...DAEMON_DOWNLINK_EVENT_FRAMES,
  ...DAEMON_DOWNLINK_RPC_FRAMES,
  ...DAEMON_DOWNLINK_TRACE_FRAMES,
  "hello",
  "welcome",
  "reject",
  "hb",
  "res",
  "ack",
];

describe("daemon protocol v2 constants", () => {
  it("pins the version to 2 and refuses v1", () => {
    expect(DAEMON_PROTOCOL_VERSION).toBe(2);
    expect(DAEMON_PROTOCOL_MIN).toBe(2);
    expect(DAEMON_PROTOCOL_MIN).toBeLessThanOrEqual(DAEMON_PROTOCOL_VERSION);
  });

  it("keeps the protocol frame cap below the socket payload cap", () => {
    // A frame that violates the protocol cap must still arrive intact so the
    // receiver can answer protocol_violation instead of the socket dying first.
    expect(DAEMON_FRAME_MAX_BYTES).toBe(1024 * 1024);
    expect(DAEMON_WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(DAEMON_FRAME_MAX_BYTES);
  });

  it("keeps the heartbeat well inside both idle timeouts", () => {
    // nginx proxy_read_timeout is 1h and Bun idleTimeout is 120s in production.
    expect(DAEMON_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(DAEMON_HEARTBEAT_INTERVAL_MS).toBeLessThan(120_000);
  });

  it("orders offer timeout, cooldown and ack timeout so a stalled offer cannot outlive its task", () => {
    expect(DAEMON_ACK_TIMEOUT_MS).toBeLessThan(DAEMON_OFFER_TIMEOUT_MS);
    expect(DAEMON_OFFER_COOLDOWN_MS).toBeGreaterThan(0);
    expect(DAEMON_UPLINK_WINDOW_FRAMES).toBeGreaterThan(0);
    expect(DAEMON_TRACE_READ_MAX_LIMIT).toBeGreaterThan(0);
  });
});

describe("daemon protocol frame inventory", () => {
  it("names every frame exactly once", () => {
    expect(new Set(ALL_FRAME_NAMES).size).toBe(ALL_FRAME_NAMES.length);
  });

  it("categorizes every frame and rejects anything else", () => {
    for (const name of ALL_FRAME_NAMES) {
      expect(daemonFrameCategory(name), `${name} has no category`).not.toBeNull();
    }
    expect(daemonFrameCategory("not_a_frame")).toBeNull();
    expect(daemonFrameCategory("")).toBeNull();
    expect(daemonFrameCategory("task.offerr")).toBeNull();
  });

  it("maps the six categories to the frames that behave that way", () => {
    expect(daemonFrameCategory("hello")).toBe("handshake");
    expect(daemonFrameCategory("welcome")).toBe("handshake");
    expect(daemonFrameCategory("reject")).toBe("handshake");
    expect(daemonFrameCategory("hb")).toBe("best_effort");
    expect(daemonFrameCategory("res")).toBe("reply");
    expect(daemonFrameCategory("ack")).toBe("ack");
    expect(daemonFrameCategory("task.offer")).toBe("event");
    expect(daemonFrameCategory("trace.append")).toBe("event");
    expect(daemonFrameCategory("trace.push")).toBe("event");
    expect(daemonFrameCategory("runtime.ready")).toBe("best_effort");
    expect(daemonFrameCategory("concierge.status")).toBe("best_effort");
    expect(daemonFrameCategory("trace.read")).toBe("rpc");
    expect(daemonFrameCategory("trace.subscribe")).toBe("rpc");
  });

  it("replays the event category, which is exactly the set that carries a seq", () => {
    for (const name of ALL_FRAME_NAMES) {
      const category = daemonFrameCategory(name);
      const mustReplay = category === "event";
      expect(daemonFrameIsReliable(name), `${name} (${category}) replay flag`).toBe(mustReplay);
      // seq and replay are the same decision, so they must never disagree.
      expect(daemonFrameUsesSeq(name), `${name} (${category}) seq flag`).toBe(mustReplay);
    }
  });

  it("keeps every non-event category off both the replay path and the seq field", () => {
    expect(daemonFrameCategory("hb")).toBe("best_effort");
    expect(daemonFrameIsReliable("hb")).toBe(false);
    expect(daemonFrameUsesSeq("hb")).toBe(false);

    // runtime.ready is best effort for the same reason hb is: it is recomputed
    // from local state on every reconnect, so there is nothing to replay.
    expect(daemonFrameCategory("runtime.ready")).toBe("best_effort");
    expect(daemonFrameIsReliable("runtime.ready")).toBe(false);

    // RPC frames pair by id and are retried by their caller, not replayed by seq.
    expect(daemonFrameCategory("steer.consume")).toBe("rpc");
    expect(daemonFrameIsReliable("steer.consume")).toBe(false);
    expect(daemonFrameUsesSeq("steer.consume")).toBe(false);
    expect(daemonFrameCategory("trace.read")).toBe("rpc");
    expect(daemonFrameIsReliable("trace.read")).toBe(false);

    expect(daemonFrameCategory("res")).toBe("reply");
    expect(daemonFrameIsReliable("res")).toBe(false);
    expect(daemonFrameCategory("ack")).toBe("ack");
    expect(daemonFrameIsReliable("ack")).toBe(false);

    // And the frames that do carry a seq say so.
    expect(daemonFrameUsesSeq("task.offer")).toBe(true);
    expect(daemonFrameUsesSeq("task.complete")).toBe(true);
    expect(daemonFrameUsesSeq("trace.append")).toBe(true);
  });

  it("windows only outbox-backed uplink frames, never trace", () => {
    expect(daemonFrameUsesOutboxWindow("task.complete")).toBe(true);
    expect(daemonFrameUsesOutboxWindow("plugin.state")).toBe(true);
    // The trace file is the buffer for trace.append, so it is not window-managed.
    expect(daemonFrameUsesOutboxWindow("trace.append")).toBe(false);
    expect(daemonFrameUsesOutboxWindow("hb")).toBe(false);
    expect(daemonFrameIsReliable("trace.append")).toBe(true);
  });

  it("carries the four trace frames the Feishu connector switch needs", () => {
    expect(DAEMON_UPLINK_RPC_FRAMES).toContain("trace.subscribe");
    expect(DAEMON_UPLINK_RPC_FRAMES).toContain("trace.unsubscribe");
    expect(DAEMON_UPLINK_RPC_FRAMES).toContain("trace.fetch");
    expect(DAEMON_DOWNLINK_TRACE_FRAMES).toContain("trace.push");
    // The read direction stays a server-initiated RPC; there is no new HTTP route.
    expect(DAEMON_DOWNLINK_RPC_FRAMES).toContain("trace.read");
  });

  it("moves the periodic maintenance polls onto RPC frames", () => {
    for (const name of ["gc.check_issue", "gc.check_chat_session", "gc.check_autopilot_run", "gc.check_task", "gc.workspace_cleaned"]) {
      expect(DAEMON_UPLINK_RPC_FRAMES).toContain(name as never);
    }
  });

  it("keeps the upgrade channel free of task traffic", () => {
    // The HTTP heartbeat stays alive only to carry an update instruction, so no
    // offer or report frame may be reachable through it.
    expect(DAEMON_DOWNLINK_EVENT_FRAMES).not.toContain("task.accept" as never);
    expect(ALL_FRAME_NAMES).not.toContain("task.claim");
  });
});

describe("daemon protocol codes", () => {
  it("keeps close codes unique and in the application range", () => {
    const codes = Object.values(DAEMON_PROTOCOL_CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it("retries only the two transient close codes", () => {
    expect(daemonCloseCodeIsRetryable(DAEMON_PROTOCOL_CLOSE_CODES.ack_timeout)).toBe(true);
    expect(daemonCloseCodeIsRetryable(DAEMON_PROTOCOL_CLOSE_CODES.server_closing)).toBe(true);
    expect(daemonCloseCodeIsRetryable(DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required)).toBe(false);
    expect(daemonCloseCodeIsRetryable(DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked)).toBe(false);
    expect(daemonCloseCodeIsRetryable(DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired)).toBe(false);
    expect(daemonCloseCodeIsRetryable(DAEMON_PROTOCOL_CLOSE_CODES.forbidden)).toBe(false);
  });

  it("keeps error codes unique and the retryable/terminal sets disjoint", () => {
    expect(new Set(DAEMON_PROTOCOL_ERROR_CODES).size).toBe(DAEMON_PROTOCOL_ERROR_CODES.length);
    for (const code of DAEMON_RETRYABLE_ERROR_CODES) {
      expect(DAEMON_PROTOCOL_ERROR_CODES).toContain(code);
      expect(DAEMON_TERMINAL_ERROR_CODES).not.toContain(code as never);
    }
    for (const code of DAEMON_TERMINAL_ERROR_CODES) {
      expect(DAEMON_PROTOCOL_ERROR_CODES).toContain(code);
    }
  });

  it("covers the four trace.read failures MUL-402 and MUL-403 branch on", () => {
    for (const code of ["daemon_unreachable", "daemon_timeout", "daemon_busy", "trace_not_hot"]) {
      expect(DAEMON_PROTOCOL_ERROR_CODES).toContain(code as never);
    }
  });

  it("keeps capability bits unique", () => {
    expect(new Set(DAEMON_PROTOCOL_CAPS).size).toBe(DAEMON_PROTOCOL_CAPS.length);
  });
});

describe("compareDaemonCliVersion", () => {
  it("orders dotted releases", () => {
    expect(compareDaemonCliVersion("0.2.83", "0.2.82")).toBe(1);
    expect(compareDaemonCliVersion("0.2.82", "0.2.83")).toBe(-1);
    expect(compareDaemonCliVersion("0.2.83", "0.2.83")).toBe(0);
    expect(compareDaemonCliVersion("0.3.0", "0.2.99")).toBe(1);
    expect(compareDaemonCliVersion("1.0.0", "0.99.99")).toBe(1);
  });

  it("tolerates a leading v and a prerelease or build suffix", () => {
    expect(compareDaemonCliVersion("v0.2.83", "0.2.83")).toBe(0);
    expect(compareDaemonCliVersion("0.2.83-rc.1", "0.2.83")).toBe(0);
    expect(compareDaemonCliVersion("0.2.83+build.7", "0.2.83")).toBe(0);
  });

  it("treats an unreadable version as older, so it has to upgrade", () => {
    expect(compareDaemonCliVersion("", "0.2.83")).toBe(-1);
    expect(compareDaemonCliVersion("dev", "0.2.83")).toBe(-1);
    expect(compareDaemonCliVersion("0.2", "0.2.83")).toBe(-1);
    expect(compareDaemonCliVersion("garbage", "garbage")).toBe(0);
  });
});

describe("meetsDaemonMinCliVersion", () => {
  it("admits the pinned minimum and anything newer", () => {
    expect(meetsDaemonMinCliVersion(DAEMON_MIN_CLI_VERSION)).toBe(true);
    expect(meetsDaemonMinCliVersion("99.0.0")).toBe(true);
  });

  it("rejects the fleet's current release, which is the point of the gate", () => {
    // Every online daemon reported v0.2.82 when MUL-401 was designed.
    expect(meetsDaemonMinCliVersion("0.2.82")).toBe(false);
    expect(meetsDaemonMinCliVersion("0.1.0")).toBe(false);
  });
});
