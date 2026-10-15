// The native steer pump (ADR 0020 "Native steering", PR3-SPEC §2.2): every
// outcome row, one call at a time, `idle()` before the run loop's `take()`,
// and force-answer arming on a native inject.
import { describe, expect, it } from "bun:test";
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import type { SteerResult } from "@shared/contracts/provider-types.js";
import { SteerPump, STEER_PUMP_MAX_CONSECUTIVE_FAILURES, steerResultGroups } from "@multiremi/worker/steer-pump.js";
import { TaskSteerFeed, type TaskSteerSource } from "@multiremi/worker/steer.js";

function message(id: string, kind: "steer" | "force_answer" = "steer"): MultiremiTaskSteerMessage {
  return { id, taskId: "tsk_1", kind, content: `body ${id}`, authorType: "user", authorId: "mem_1",
    createdAt: "2026-10-15T08:00:00.000Z", consumedAt: null };
}

function harness(answers: Array<SteerResult | Promise<SteerResult>> = []) {
  let push: (message: MultiremiTaskSteerMessage) => void = () => {};
  const source: TaskSteerSource = {
    pendingTaskSteerMessages: () => [],
    subscribeTaskSteerMessages: (_taskId, listener) => { push = listener; return () => {}; },
  };
  const feed = new TaskSteerFeed(source, "tsk_1");
  feed.start();
  const calls: string[] = [];
  const injected: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let aborts = 0;
  let armed = 0;
  let expired = false;
  const pending = [...answers];
  const pump = new SteerPump({
    feed,
    steer: async (text) => {
      calls.push(text);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await (pending.shift() ?? { outcome: "injected" });
      } finally { inFlight--; }
    },
    prepare: async (messages) => messages.map((m) => m.content).join(" + "),
    injected: (messages) => { injected.push(messages.map((m) => m.id)); },
    armForceAnswer: () => { armed++; },
    forceAnswerExpired: () => expired,
  });
  let round = 0;
  const h = {
    pump, feed, calls, injected,
    get aborts() { return aborts; },
    get armed() { return armed; },
    get maxInFlight() { return maxInFlight; },
    expire() { expired = true; },
    send(id: string, kind: "steer" | "force_answer" = "steer") {
      push(message(id, kind));
    },
    /** Begin a round wired the way the daemon wires it. */
    begin({ started = true }: { started?: boolean } = {}) {
      round++;
      pump.beginRound(() => { aborts++; });
      feed.setInterrupt(() => pump.interrupt());
      if (started) pump.promptStarted();
      return round;
    },
    end() {
      feed.setInterrupt(null);
      pump.endRound();
    },
  };
  return h;
}

const settle = () => Bun.sleep(5);

describe("SteerPump outcomes", () => {
  it("injected: the prompt keeps running and the batch is recorded natively", async () => {
    const h = harness([{ outcome: "injected" }]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.calls).toEqual(["body s1"]);
    expect(h.injected).toEqual([["s1"]]);
    expect(h.aborts).toBe(0);
    expect(h.feed.hasPending).toBe(false);
    expect(h.pump.takeFallback("s1")).toBeNull();
  });

  it("promptRequired (prompt ended): requeued for the re-prompt, the round is not interrupted", async () => {
    const h = harness([{ outcome: "promptRequired", reason: "noActivePrompt" }]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.aborts).toBe(0);
    expect(h.feed.take().map((m) => m.id)).toEqual(["s1"]);
    expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: "promptRequired", error: null });
    // The round is ending by itself: a later steer in it waits for the re-prompt.
    h.send("s2");
    await h.pump.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.aborts).toBe(0);
    expect(h.pump.nativeEnabled).toBe(true);
  });

  for (const reason of ["noRunningTurn", "toolCallRunning", "userInputPending"]) {
    it(`promptRequired (${reason}, prompt still running): interrupt and re-prompt, not a native failure`, async () => {
      const h = harness([{ outcome: "promptRequired", reason }, { outcome: "promptRequired", reason }, { outcome: "promptRequired", reason }]);
      for (const id of ["s1", "s2", "s3"]) {
        h.begin();
        h.send(id);
        await h.pump.idle();
        h.end();
        expect(h.feed.take().map((m) => m.id)).toEqual([id]);
      }
      expect(h.aborts).toBe(3);
      expect(h.calls).toHaveLength(3);
      expect(h.pump.nativeEnabled).toBe(true);
      expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: "promptRequired", error: reason });
    });
  }

  it("startedNewTurn: requeued; a round that already ended is never interrupted", async () => {
    const answer = Promise.withResolvers<SteerResult>();
    const h = harness([answer.promise]);
    h.begin();
    h.send("s1");
    await settle();
    h.end();
    answer.resolve({ outcome: "startedNewTurn" });
    await h.pump.idle();
    expect(h.aborts).toBe(0);
    expect(h.feed.take().map((m) => m.id)).toEqual(["s1"]);
    expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: "startedNewTurn", error: null });
    expect(h.pump.nativeEnabled).toBe(true);
  });

  it("startedNewTurn: a round still streaming is interrupted", async () => {
    const h = harness([{ outcome: "startedNewTurn" }]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.aborts).toBe(1);
    expect(h.feed.take().map((m) => m.id)).toEqual(["s1"]);
  });

  it("failed: requeued and interrupted; native turns off after consecutive failures", async () => {
    const h = harness([{ outcome: "failed", error: "boom" }, { outcome: "failed", error: "boom again" }]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.aborts).toBe(1);
    expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: "failed", error: "boom" });
    expect(h.pump.nativeEnabled).toBe(true);
    h.end();
    h.feed.take();

    h.begin();
    h.send("s2");
    await h.pump.idle();
    expect(h.aborts).toBe(2);
    expect(STEER_PUMP_MAX_CONSECUTIVE_FAILURES).toBe(2);
    expect(h.pump.nativeEnabled).toBe(false);
    h.end();
    h.feed.take();

    // Off for the rest of the attempt: the interrupt is today's abort, with no call.
    h.begin();
    h.send("s3");
    await h.pump.idle();
    expect(h.calls).toHaveLength(2);
    expect(h.aborts).toBe(3);
    expect(h.pump.takeFallback("s3")).toBeNull();
  });

  it("failed: an injection in between resets the failure count", async () => {
    const h = harness([{ outcome: "failed" }, { outcome: "injected" }, { outcome: "failed" }]);
    for (const id of ["s1", "s2", "s3"]) {
      h.begin();
      h.send(id);
      await h.pump.idle();
      h.end();
      h.feed.take();
    }
    expect(h.calls).toHaveLength(3);
    expect(h.pump.nativeEnabled).toBe(true);
  });

  it("a thrown steer counts as failed", async () => {
    const h = harness([Promise.reject(new Error("socket closed"))]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.aborts).toBe(1);
    expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: "failed", error: "socket closed" });
  });

  it("unsupported: requeued, interrupted, and native off at once", async () => {
    const h = harness([{ outcome: "unsupported" }]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.aborts).toBe(1);
    expect(h.pump.nativeEnabled).toBe(false);
    expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: "unsupported", error: null });
  });

  it("a failed prepare falls back without counting as a native failure", async () => {
    const h = harness();
    (h.pump as unknown as { options: { prepare: () => Promise<string> } }).options.prepare = async () => {
      throw new Error("attachment download failed");
    };
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.calls).toHaveLength(0);
    expect(h.aborts).toBe(1);
    expect(h.pump.takeFallback("s1")).toEqual({ via: "reprompt", native_outcome: null, error: "attachment download failed" });
    expect(h.pump.nativeEnabled).toBe(true);
  });
});

describe("SteerPump rules", () => {
  it("waits for onPromptStarted before the first call", async () => {
    const h = harness();
    h.begin({ started: false });
    h.send("s1");
    await h.pump.idle();
    expect(h.calls).toHaveLength(0);
    expect(h.aborts).toBe(0);
    h.pump.promptStarted();
    await h.pump.idle();
    expect(h.calls).toEqual(["body s1"]);
  });

  it("makes one call at a time and batches what arrived meanwhile", async () => {
    const first = Promise.withResolvers<SteerResult>();
    const h = harness([first.promise, { outcome: "injected" }]);
    h.begin();
    h.send("s1");
    await settle();
    h.send("s2");
    h.send("s3");
    await settle();
    expect(h.calls).toEqual(["body s1"]);
    first.resolve({ outcome: "injected" });
    await h.pump.idle();
    expect(h.calls).toEqual(["body s1", "body s2 + body s3"]);
    expect(h.injected).toEqual([["s1"], ["s2", "s3"]]);
    expect(h.maxInFlight).toBe(1);
  });

  it("idle() resolves only once a late answer has been handled, so take() sees the requeue", async () => {
    const answer = Promise.withResolvers<SteerResult>();
    const h = harness([answer.promise]);
    h.begin();
    h.send("s1");
    await settle();
    h.end();
    expect(h.feed.hasPending).toBe(false);
    let idle = false;
    const waiting = h.pump.idle().then(() => { idle = true; });
    await settle();
    expect(idle).toBe(false);
    answer.resolve({ outcome: "promptRequired", reason: "noActivePrompt" });
    await waiting;
    expect(h.feed.take().map((m) => m.id)).toEqual(["s1"]);
  });

  it("requeues in front of steers that arrived during the call, in order", async () => {
    const answer = Promise.withResolvers<SteerResult>();
    const h = harness([answer.promise]);
    h.begin();
    h.send("s1");
    h.send("s2");
    await settle();
    h.send("s3");
    answer.resolve({ outcome: "failed" });
    await h.pump.idle();
    expect(h.feed.take().map((m) => m.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("arms force-answer as soon as the wrap-up is handed to the native call", async () => {
    const answer = Promise.withResolvers<SteerResult>();
    const h = harness([answer.promise]);
    h.begin();
    h.send("wrap_up:1", "force_answer");
    await settle();
    // The provider may still hold it while a tool call runs; the grace already
    // counts (armed on arrival and again at hand-off: arming is idempotent).
    expect(h.calls).toHaveLength(1);
    const armedAtHandOff = h.armed;
    expect(armedAtHandOff).toBeGreaterThan(0);
    answer.resolve({ outcome: "injected" });
    await h.pump.idle();
    expect(h.injected).toEqual([["wrap_up:1"]]);
    expect(h.armed).toBe(armedAtHandOff);
  });

  it("arms force-answer when a wrap-up arrives behind a steer the provider still holds", async () => {
    const held = Promise.withResolvers<SteerResult>();
    const h = harness([held.promise, { outcome: "injected" }]);
    h.begin();
    h.send("s1");
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.armed).toBe(0);
    // S1 is held (a running tool call); the wrap-up's grace starts now, not after S1.
    h.send("wrap_up:1", "force_answer");
    expect(h.armed).toBe(1);
    expect(h.calls).toHaveLength(1);
    held.resolve({ outcome: "injected" });
    await h.pump.idle();
    expect(h.injected).toEqual([["s1"], ["wrap_up:1"]]);
  });

  it("does not arm force-answer for an ordinary steer", async () => {
    const h = harness([{ outcome: "injected" }]);
    h.begin();
    h.send("s1");
    await h.pump.idle();
    expect(h.armed).toBe(0);
  });

  it("makes no call once the force-answer grace has expired", async () => {
    const h = harness();
    h.begin();
    h.expire();
    h.send("s1");
    await h.pump.idle();
    expect(h.calls).toHaveLength(0);
    expect(h.aborts).toBe(0);
    // Left for the run loop, which records it without delivery.
    expect(h.feed.take().map((m) => m.id)).toEqual(["s1"]);
  });

  it("ignores answers after stop", async () => {
    const answer = Promise.withResolvers<SteerResult>();
    const h = harness([answer.promise]);
    h.begin();
    h.send("s1");
    await settle();
    h.pump.stop();
    answer.resolve({ outcome: "failed" });
    await h.pump.idle();
    expect(h.aborts).toBe(0);
    expect(h.injected).toEqual([]);
  });
});

describe("steerResultGroups", () => {
  it("groups a batch by the result each message gets", () => {
    const fallbacks = new Map([["s1", { via: "reprompt" as const, native_outcome: "failed" as const, error: "boom" }]]);
    const take = (id: string) => fallbacks.get(id) ?? null;
    expect(steerResultGroups([message("s1"), message("s2"), message("s3")], "reprompt", take).map(([result, group]) =>
      [result, group.map((m) => m.id)])).toEqual([
      [{ via: "reprompt", native_outcome: "failed", error: "boom" }, ["s1"]],
      [{ via: "reprompt", native_outcome: null, error: null }, ["s2", "s3"]],
    ]);
    expect(steerResultGroups([message("s4")], "native", () => null)[0]![0]).toEqual({ via: "native", native_outcome: "injected", error: null });
    expect(steerResultGroups([message("s1")], "none", take)[0]![0]).toEqual({ via: "none", native_outcome: "failed", error: "boom" });
  });
});
