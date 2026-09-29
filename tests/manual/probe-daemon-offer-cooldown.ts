import { strict as assert } from "node:assert";
import { DaemonProtocolHarness, waitFor } from "../integration/daemon-protocol-v2/harness.js";

const elapsed: number[] = [];
for (let round = 0; round < 10; round++) {
  const h = await DaemonProtocolHarness.create({ daemonOptions: { maxConcurrency: 1 } });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "Capacity probe", provider: "claude", runtimeId, workspaceId: "local" });
    const local = h.daemon as unknown as { activeTaskCount: number; releaseActiveTaskSlot(): void };
    // The server's last heartbeat still reports an empty slot; the local offer guard now sees it full.
    local.activeTaskCount = 1;
    const task = h.store.createTask({ agentId: agent.id, prompt: `capacity probe ${round}` });
    const offers = () => h.sockets.flatMap(socket => socket.frames)
      .filter(frame => frame.t === "task.offer" && frame.p.id === task.id);
    const capacityBefore = h.ledger.filter(entry => entry.type === "res" && entry.frame.p.code === "capacity").length;
    await waitFor(() => offers().length === 1, `first offer ${round}`, 5_000);
    await waitFor(() => h.ledger.filter(entry => entry.type === "res" && entry.frame.p.code === "capacity").length > capacityBefore,
      `capacity rejection ${round}`, 5_000);
    assert.equal(h.store.getTask(task.id)?.status, "queued");
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
const sorted = [...elapsed].sort((a, b) => a - b);
console.log(`[Q418-cooldown] samples=${sorted.length} p50_ms=${((sorted[4]! + sorted[5]!) / 2).toFixed(1)} max_ms=${sorted.at(-1)!.toFixed(1)}`);
