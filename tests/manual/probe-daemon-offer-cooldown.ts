import { strict as assert } from "node:assert";
import { DaemonProtocolHarness, waitFor } from "../integration/daemon-protocol-v2/harness.js";

const elapsed: number[] = [];
const storm = process.argv[2] === "storm";
const rounds = storm ? 1 : Number(process.argv[2] ?? 10);
for (let round = 0; round < rounds; round++) {
  const h = await DaemonProtocolHarness.create({ daemonOptions: { maxConcurrency: 1 } });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "Capacity probe", provider: "claude", runtimeId, workspaceId: "local" });
    const local = h.daemon as unknown as { activeTaskCount: number; releaseActiveTaskSlot(): void };
    // The task is still queued, so the server can offer it even while the daemon reports a full local slot.
    local.activeTaskCount = 1;
    h.daemon.daemonProtocolClient().sendHeartbeatNow();
    await waitFor(() => h.ledger.some(entry => entry.type === "hb" && entry.frame.p.active_task_count === 1),
      `full-capacity heartbeat ${round}`);
    await h.layer.drain();
    const task = h.store.createTask({ agentId: agent.id, prompt: `capacity probe ${round}` });
    const offers = () => h.sockets.flatMap(socket => socket.frames)
      .filter(frame => frame.t === "task.offer" && frame.p.id === task.id);
    const capacityBefore = h.ledger.filter(entry => entry.type === "res" && entry.frame.p.code === "capacity").length;
    await waitFor(() => offers().length === 1, `first offer ${round}`, 5_000);
    await waitFor(() => h.ledger.filter(entry => entry.type === "res" && entry.frame.p.code === "capacity").length > capacityBefore,
      `capacity rejection ${round}`, 5_000);
    assert.equal(h.store.getTask(task.id)?.status, "queued");
    if (storm) {
      await Bun.sleep(60_000);
      assert.ok(offers().length <= 3, `full-capacity offers in 60 seconds: ${offers().length}`);
      console.log(`[Q418-cooldown] full_capacity_60s_offers=${offers().length} capacity_rejections=${h.ledger.filter(entry => entry.type === "res" && entry.frame.p.code === "capacity").length - capacityBefore}`);
      continue;
    }
    local.releaseActiveTaskSlot();
    const releasedAt = performance.now();
    await waitFor(() => offers().length >= 2, `second offer ${round}`, 40_000);
    const waitMs = performance.now() - releasedAt;
    elapsed.push(waitMs);
    await waitFor(() => h.store.getTask(task.id)?.status === "completed", `completion ${round}`, 5_000);
    await waitFor(() => h.effectiveLedger.some(entry => entry.type === "task.complete" && entry.partition === task.id),
      `completion report ${round}`, 5_000);
    await h.settleHeartbeat();
    console.log(`[Q418-cooldown] round=${round + 1} release_to_offer_ms=${waitMs.toFixed(1)} capacity_rejections=1`);
  } finally {
    await h.dispose();
  }
}
if (!storm) {
  const sorted = [...elapsed].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  console.log(`[Q418-cooldown] samples=${sorted.length} p50_ms=${p50.toFixed(1)} max_ms=${sorted.at(-1)!.toFixed(1)}`);
}
