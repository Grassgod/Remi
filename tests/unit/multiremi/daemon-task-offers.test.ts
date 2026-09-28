import { afterEach, describe, expect, it } from "bun:test";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers } from "@multiremi/api/daemon-protocol/task-offers.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { createLocalStore, resetMultiremiTestEnv, db } from "./helpers.js";

const layers: DaemonProtocolLayer[] = [];
afterEach(async () => {
  for (const layer of layers.splice(0)) { layer.closeAll(); layer.stop(); await layer.drain(); }
  resetMultiremiTestEnv();
});

function fixture(prepare?: (task: MultiremiTaskWithAgent) => Promise<Record<string, unknown> | null>, runtimeCount = 1) {
  const store = createLocalStore();
  const runtimeIds = Array.from({ length: runtimeCount }, (_, index) => {
    const id = `rt_offer_${index}`;
    store.registerRuntime({ id, name: id, daemonId: "dmn_offer", workspaceId: "local", provider: "claude",
      ownerId: "local", status: "online", maxConcurrency: 1, metadata: { parallel_agent_execution: 1 } });
    return id;
  });
  const agentIds = runtimeIds.map(runtimeId => store.createAgent({ name: runtimeId, runtimeId,
    provider: "claude", workspaceId: "local" }).id);
  const clock = new ManualDaemonProtocolClock(Date.now());
  const layer = new DaemonProtocolLayer({ store });
  layers.push(layer);
  const offers = new DaemonTaskOffers({ store, layer, clock,
    prepare: prepare ?? (async task => ({ id: task.id, prompt: task.prompt, runtime_id: task.runtimeId, auth_token: "fixture-capability" })) });
  const frames: Record<string, any>[] = [];
  let sendStatus: number | null = null;
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return sendStatus ?? text.length; }, close() {} },
    { accessToken: null, masterToken: true });
  const send = (t: string, p: unknown, fields: Record<string, unknown> = {}) => session.handleMessage(JSON.stringify({ v: 2, t, p, ...fields }));
  const hello = async () => {
    await send("hello", { protocol: 2, daemon_id: "dmn_offer", cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"],
      runtimes: runtimeIds.map(runtime_id => ({ runtime_id, provider: "claude", max_concurrency: 1, active_task_ids: [] })) });
    await layer.drain();
  };
  const task = (index = 0, prompt = "no-op") => store.createTask({ agentId: agentIds[index]!, prompt, maxAttempts: 1 });
  const offered = () => frames.filter(frame => frame.t === "task.offer");
  const accept = async (frame = offered().at(-1)!) => {
    await send("res", { ok: true }, { re: String(frame.seq), ack: frame.seq });
    await layer.drain();
  };
  return { store, runtimeIds, clock, layer, offers, session, send, hello, task, offered, frames, accept,
    setSendStatus: (value: number | null) => { sendStatus = value; } };
}

describe("A-3 task offers", () => {
  it("hello offers the existing queue, with the claim payload and capability intact", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    expect(h.offered()).toHaveLength(1);
    expect(h.offered()[0]!.p).toMatchObject({ id: task.id, prompt: task.prompt, auth_token: "fixture-capability" });
    expect(h.store.getTask(task.id)?.offeredAt).not.toBeNull();
    await h.accept();
    expect(h.store.getTask(task.id)?.acceptedAt).not.toBeNull();
  });

  it("keeps preparation single-flight when enqueue kicks overlap", async () => {
    let release!: () => void; let calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = fixture(async task => { calls++; await gate; return { id: task.id }; });
    await h.hello(); h.task();
    for (let i = 0; i < 20; i++) h.offers.kick(h.runtimeIds[0]);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release(); await h.layer.drain();
    expect(calls).toBe(1); expect(h.offered()).toHaveLength(1);
  });

  it("offers on enqueue and on a terminal report freeing capacity", async () => {
    const h = fixture(); await h.hello();
    const first = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain(); await h.accept();
    h.store.startTask(first.id);
    const next = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain();
    expect(h.offered()).toHaveLength(1);
    h.store.completeTask(first.id, { output: "done" }); h.offers.terminal(first.id, h.runtimeIds[0]!); await h.layer.drain();
    expect(h.offered().at(-1)!.p.id).toBe(next.id);
  });

  it("kicks on a changed heartbeat count, not on an unchanged count", async () => {
    const h = fixture(); await h.hello();
    await h.send("hb", { active_task_count: 0 }, { id: "hb1" }); await h.layer.drain();
    const task = h.task();
    await h.send("hb", { active_task_count: 0 }, { id: "hb2" }); await h.layer.drain();
    expect(h.offered()).toHaveLength(0);
    await h.send("hb", { active_task_count: 1 }, { id: "hb3" }); await h.layer.drain();
    expect(h.offered()[0]!.p.id).toBe(task.id);
  });

  it("requeues an unanswered offer at 30s and cools that runtime for another 30s", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    h.clock.advance(29_999); expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    h.clock.advance(1); expect(h.store.getTask(task.id)?.status).toBe("queued");
    h.offers.kick(h.runtimeIds[0]); await h.layer.drain(); expect(h.offered()).toHaveLength(1);
    h.clock.advance(29_999); await h.layer.drain(); expect(h.offered()).toHaveLength(1);
    h.clock.advance(1); await h.layer.drain(); expect(h.offered()).toHaveLength(2);
  });

  it("reject cools only the rejecting runtime on a shared daemon", async () => {
    const h = fixture(undefined, 2); const first = h.task(0); const second = h.task(1); await h.hello();
    const rejected = h.offered().find(frame => frame.p.id === first.id)!;
    await h.send("res", { ok: false, code: "capacity" }, { re: String(rejected.seq), ack: rejected.seq });
    await h.layer.drain();
    expect(h.store.getTask(first.id)?.status).toBe("queued");
    await h.accept(h.offered().find(frame => frame.p.id === second.id)!);
    expect(h.store.getTask(second.id)?.acceptedAt).not.toBeNull();
    h.offers.kick(); await h.layer.drain(); expect(h.offered()).toHaveLength(2);
  });

  it("disconnect requeues unaccepted work, but preserves accepted work and drops its lease", async () => {
    const h = fixture(); const task = h.task(); await h.hello(); h.session.handleSocketClose();
    expect(h.store.getTask(task.id)?.status).toBe("queued");
    expect(h.store.getTask(task.id)?.acceptedAt).toBeNull();
  });

  it("holds a dispatched lease after accept, and keeps 90s recovery as the final fallback", async () => {
    const h = fixture(); const task = h.task(); await h.hello(); await h.accept();
    db!.run("UPDATE multiremi_tasks SET dispatched_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [task.id]);
    expect(h.store.claimTask(h.runtimeIds[0]!)).toBeNull();
    h.session.handleSocketClose();
    expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    expect(h.store.claimTask(h.runtimeIds[0]!)?.id).toBe(task.id);
  });

  it("fails a >1MiB offer and offers the next task without blocking the runtime", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt }));
    const huge = h.task(0, "x".repeat(1_048_576)); const next = h.task(); await h.hello();
    expect(h.store.getTask(huge.id)?.status).toBe("failed");
    expect(h.store.getTask(huge.id)?.error).toContain("1 MiB");
    expect(h.offered()).toHaveLength(1); expect(h.offered()[0]!.p.id).toBe(next.id);
  });

  it("does not reset an accepted Chat dispatch through the stale workspace recovery path", async () => {
    const h = fixture();
    const project = h.store.createProject({ title: "leased Chat" });
    const agent = h.store.createAgent({ name: "leased Chat", provider: "claude", runtimeId: h.runtimeIds[0]! });
    const chat = h.store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = h.store.sendChatMessage(chat.id, { body: "no-op" }).task;
    await h.hello(); await h.accept();
    const stale = "chat-workspace:deadbeef:managed:frozen";
    db!.run("UPDATE multiremi_tasks SET dispatched_at = '2000-01-01T00:00:00.000Z', execution_fingerprint = ? WHERE id = ?", [stale, task.id]);
    expect(h.store.claimTask(h.runtimeIds[0]!)).toBeNull();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "dispatched", executionFingerprint: stale });
    h.session.handleSocketClose();
    expect(h.store.claimTask(h.runtimeIds[0]!)?.id).toBe(task.id);
    expect(h.store.getTask(task.id)?.executionFingerprint).not.toBe(stale);
  });

  it("derives pending work again after a full window receives an ack", async () => {
    const h = fixture(); await h.hello();
    for (let i = 0; i < 64; i++) expect(h.session.sendEvent({ t: "plugin.desired_revision", p: { revision: i } }).ok).toBe(true);
    const task = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain();
    expect(h.store.getTask(task.id)?.status).toBe("queued"); expect(h.offered()).toHaveLength(0);
    await h.send("ack", { ack: 64 }); await h.layer.drain(); expect(h.offered()[0]!.p.id).toBe(task.id);
  });

  it("waits for drain when the socket is paused", async () => {
    const h = fixture(); await h.hello(); h.setSendStatus(-1);
    h.session.sendEvent({ t: "plugin.desired_revision", p: { revision: 1 } }); h.setSendStatus(null);
    const task = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain(); expect(h.offered()).toHaveLength(0);
    h.session.handleDrain(); await h.layer.drain(); expect(h.offered()[0]!.p.id).toBe(task.id);
  });

  it("runtime.ready cancels terminal active tasks, recovers missing running tasks and preserves active ones", async () => {
    const h = fixture(); const terminal = h.task(); const missing = h.task(); const active = h.task();
    h.store.claimTask(h.runtimeIds[0]!); h.store.startTask(terminal.id); h.store.completeTask(terminal.id, { output: "done" });
    db!.run("UPDATE multiremi_tasks SET status = 'running', runtime_id = ? WHERE id IN (?, ?)", [h.runtimeIds[0]!, missing.id, active.id]);
    await h.hello(); await h.send("runtime.ready", { active_task_ids: [terminal.id, active.id] }, { rt: h.runtimeIds[0] }); await h.layer.drain();
    expect(h.frames.filter(frame => frame.t === "task.cancelled")).toHaveLength(1);
    expect(h.store.getTask(missing.id)?.status).toBe("failed");
    expect(h.store.getTask(active.id)?.status).toBe("running");
  });

  it("never recovers another runtime named in an unauthorized ready", async () => {
    const h = fixture(); await h.hello(); const task = h.task();
    await h.send("runtime.ready", { active_task_ids: [] }, { rt: "rt_foreign" }); await h.layer.drain();
    expect(h.store.getTask(task.id)?.status).toBe("queued");
  });
});
