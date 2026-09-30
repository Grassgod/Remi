import "../setup/hermetic-env.js";
import { DaemonProtocolHarness, waitFor } from "../integration/daemon-protocol-v2/harness.js";

const count = 200;
const h = await DaemonProtocolHarness.create();
try {
  await h.startDaemon();
  await h.settleHeartbeat();
  const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
  const agent = h.store.createAgent({ name: "dispatch latency no-op", provider: "claude", runtimeId, workspaceId: "local" });
  const ids: string[] = [];
  // Keep the runtime idle at each enqueue so queue residence does not dominate dispatch.
  for (let index = 0; index < count; index++) {
    const task = h.store.createTask({ agentId: agent.id, prompt: `no-op ${index}` });
    ids.push(task.id);
    await waitFor(() => h.store.getTask(task.id)?.status === "completed", `no-op ${index}`, 10_000);
  }
  const samples = { "created->offered": [] as number[], "offered->accepted": [] as number[], "accepted->started": [] as number[] };
  for (const id of ids) {
    const task = h.store.getTask(id)!;
    if (!task.offeredAt || !task.acceptedAt || !task.startedAt) throw new Error(`Missing dispatch timestamp for ${id}`);
    samples["created->offered"].push(Date.parse(task.offeredAt) - Date.parse(task.createdAt));
    samples["offered->accepted"].push(Date.parse(task.acceptedAt) - Date.parse(task.offeredAt));
    samples["accepted->started"].push(Date.parse(task.startedAt) - Date.parse(task.acceptedAt));
  }
  const results = Object.fromEntries(Object.entries(samples).map(([stage, values]) => {
    values.sort((a, b) => a - b);
    const percentile = (p: number) => values[Math.ceil(values.length * p) - 1]!;
    return [stage, { p50_ms: percentile(0.5), p95_ms: percentile(0.95), samples: values.length }];
  }));
  console.log(JSON.stringify({ runtime: "idle", tasks: count, results }, null, 2));
} finally { await h.dispose(); }
