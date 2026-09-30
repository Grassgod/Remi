import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { MIGRATION_ADVISORY_LOCK_KEY } from "../../packages/server/src/store/advisory-locks.js";
import {
  pollUntil, redactDiagnostic, TwoProcessResources,
  type ApiChild, type FreshDatabase, type ProcessPair,
} from "../helpers/two-process.js";

const configured = Boolean(process.env.MULTIREMI_TEST_POSTGRES_URL);
if (!configured) console.info("[MUL-463] SKIP: MULTIREMI_TEST_POSTGRES_URL is not set; two real API processes require an isolated PostgreSQL database.");

interface Seed { agentId: string; issueId: string; browserToken: string }
interface Queue { agentId: string; runtimeIds: [string, string] }
interface Frame { type?: string; payload?: any; t?: string; p?: any; seq?: number; rt?: string }
interface TaskState { id: string; status: string; runtimeId: string }
interface PeerHealth { enabled: boolean; sent: number; dropped: number; failed: number; queued: number; inflight: number }
const BunSocket = WebSocket as unknown as { new(url: string, options?: Bun.WebSocketOptions): WebSocket };

class SocketFrames {
  readonly socket: WebSocket;
  readonly frames: Frame[] = [];
  constructor(url: string, token?: string) {
    this.socket = new BunSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    this.socket.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data))));
    this.socket.addEventListener("error", () => {});
  }
  async open(): Promise<void> {
    expect(await pollUntil(() => this.socket.readyState === WebSocket.OPEN)).toBe(true);
  }
  async wait(type: string, predicate: (frame: Frame) => boolean = () => true): Promise<Frame | undefined> {
    await pollUntil(() => this.frames.some((frame) => (frame.type ?? frame.t) === type && predicate(frame)), 5000);
    return this.frames.find((frame) => (frame.type ?? frame.t) === type && predicate(frame));
  }
  close(): void { this.socket.close(); }
}

describe.skipIf(!configured)("MUL-463 two-process PostgreSQL integration", () => {
  let resources: TwoProcessResources;
  let database: FreshDatabase;
  let pair: ProcessPair;
  let seed: Seed;
  const sockets = new Set<SocketFrames>();
  const started = performance.now();

  async function timed(number: number, run: () => Promise<void>): Promise<void> {
    const start = performance.now();
    try { await run(); }
    finally { console.info(`[MUL-463] scenario ${number}: ${(performance.now() - start).toFixed(0)}ms`); }
  }

  async function health(child: ApiChild): Promise<PeerHealth> {
    const response = await fetch(`${child.url}/internal/peer/health`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    return await response.json() as PeerHealth;
  }

  async function browser(): Promise<SocketFrames> {
    const collector = new SocketFrames(`${pair[0].url.replace("http:", "ws:")}/ws?workspace_slug=local`);
    sockets.add(collector);
    await collector.open();
    collector.socket.send(JSON.stringify({ type: "auth", payload: { token: seed.browserToken } }));
    expect((await collector.wait("auth_ack"))?.type).toBe("auth_ack");
    return collector;
  }

  async function daemon(runtimeId: string): Promise<SocketFrames> {
    const collector = new SocketFrames(`${pair[1].url.replace("http:", "ws:")}/api/daemon/ws?protocol=2`, resources.authToken);
    sockets.add(collector);
    await collector.open();
    collector.socket.send(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION,
      daemon_id: runtimeId.replace(/^rt_/, "daemon_"),
      runtimes: [{ runtime_id: runtimeId, provider: "codex", max_concurrency: 2, active_task_ids: [] }],
    } }));
    expect((await collector.wait("welcome"))?.t).toBe("welcome");
    return collector;
  }

  async function claim(runtimeId: string): Promise<string | null> {
    const response = await fetch(`${pair[1].url}/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
      method: "POST", headers: { Authorization: `Bearer ${resources.authToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    // The response contains a task credential; keep it out of assertion output.
    const body = await response.json() as { task: { id: string } | null };
    return body.task?.id ?? null;
  }

  if (configured) beforeAll(async () => {
    resources = new TwoProcessResources();
    database = await resources.freshDatabase();
    pair = await resources.spawnPair(database.url, false);
    // Functional scenarios need a running schema; migration contention is
    // deliberately isolated in scenario 1 so a mutant fails that assertion.
    for (const child of pair) {
      child.start();
      await child.ready();
    }
    seed = await pair[0].call<Seed>("seed");
  }, 30_000);

  if (configured) afterAll(async () => {
    for (const socket of sockets) socket.close();
    try { await resources?.cleanup(); }
    finally { console.info(`[MUL-463] file total: ${(performance.now() - started).toFixed(0)}ms; 7 scenarios registered`); }
  }, 30_000);

  it("1. concurrently cold-starts ui/runtime on 20 fresh databases with zero failures", () => timed(1, async () => {
    const failures: string[] = [];
    let contendedRounds = 0;
    for (let round = 0; round < 20; round += 1) {
      const cold = await resources.freshDatabase();
      const gate = new Bun.SQL(cold.url, { max: 1 });
      let children: ProcessPair | undefined;
      let locked = false;
      try {
        // Hold the actual migration lock until BOTH OS processes are waiting.
        // This proves overlapping cold starts even on a heavily loaded runner.
        await gate`SELECT pg_advisory_lock(hashtext(${MIGRATION_ADVISORY_LOCK_KEY}))`;
        locked = true;
        children = await resources.spawnPair(cold.url, false);
        expect(children[0].process.pid).not.toBe(children[1].process.pid);
        children.forEach((child) => child.start());
        const contended = await pollUntil(async () => {
          const rows = await gate`SELECT COUNT(*)::int AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
          return rows[0].waiting === 2;
        }, 3000);
        if (contended) contendedRounds += 1;
        await gate`SELECT pg_advisory_unlock(hashtext(${MIGRATION_ADVISORY_LOCK_KEY}))`;
        locked = false;
        await Promise.all(children.map((child) => child.ready()));
        const roles = await Promise.all(children.map(async (child) => {
          const response = await fetch(`${child.url}/readyz`, { signal: AbortSignal.timeout(2000) });
          return (await response.json() as { role: string }).role;
        }));
        expect(roles).toEqual(["ui", "runtime"]);
      } catch (error) {
        failures.push(`round ${round + 1}: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}`);
      } finally {
        if (locked) await gate`SELECT pg_advisory_unlock(hashtext(${MIGRATION_ADVISORY_LOCK_KEY}))`;
        await gate.end();
        if (children) await resources.stopPair(children);
        await resources.dropDatabase(cold.name);
      }
    }
    expect(failures).toEqual([]);
    expect(contendedRounds).toBe(20);
  }), 110_000);

  it("2. delivers comment:created from runtime B to a browser on ui A, 20/20", () => timed(2, async () => {
    const socket = await browser();
    try {
      const ids = await pair[1].call<string[]>("comments", { ...seed, count: 20, label: "delivery" });
      const received = () => socket.frames.filter((frame) => frame.type === "comment:created")
        .map((frame) => frame.payload.comment.id as string).filter((id) => ids.includes(id));
      await pollUntil(() => received().length >= 20, 5000);
      expect(received().sort()).toEqual([...ids].sort());
      expect(new Set(received()).size).toBe(20);
    } finally { socket.close(); }
  }), 20_000);

  it("3. claims a task enqueued on A from a v2 daemon session on B", () => timed(3, async () => {
    const queue = await pair[0].call<Queue>("queue");
    const socket = await daemon(queue.runtimeIds[0]);
    try {
      const id = await pair[0].call<string>("enqueue", { agentId: queue.agentId, runtimeId: queue.runtimeIds[0] });
      expect(await claim(queue.runtimeIds[0])).toBe(id);
      expect(await pair[1].call<TaskState>("task", { id })).toEqual({ id, status: "dispatched", runtimeId: queue.runtimeIds[0] });
      await pair[0].call("complete", { id });
    } finally { socket.close(); }
  }), 20_000);

  it("4. lets two v2 daemons on B race for the same queue 200 times without duplicate claims", () => timed(4, async () => {
    const queue = await pair[0].call<Queue>("queue");
    const daemons = await Promise.all(queue.runtimeIds.map((id) => daemon(id)));
    const delivered: string[] = [];
    try {
      for (let round = 0; round < 200; round += 1) {
        const id = await pair[0].call<string>("enqueue", { agentId: queue.agentId });
        const claimed = await Promise.all(queue.runtimeIds.map((runtimeId) => claim(runtimeId)));
        const winners = claimed.filter((taskId): taskId is string => taskId !== null);
        expect(winners).toEqual([id]);
        const owner = queue.runtimeIds[claimed.indexOf(id)];
        expect(await pair[1].call<TaskState>("task", { id })).toEqual({ id, status: "dispatched", runtimeId: owner });
        delivered.push(...winners);
        await pair[0].call("complete", { id });
      }
      expect(delivered).toHaveLength(200);
      expect(new Set(delivered).size).toBe(200);
    } finally { daemons.forEach((socket) => socket.close()); }
  }), 60_000);

  it("5. rejects daemon heartbeat on ui A and browser issues on runtime B with 421", () => timed(5, async () => {
    const heartbeat = await fetch(`${pair[0].url}/api/daemon/heartbeat`, {
      method: "POST", headers: { Authorization: `Bearer ${resources.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: "misdirected" }), signal: AbortSignal.timeout(2000),
    });
    const issues = await fetch(`${pair[1].url}/api/issues`, {
      headers: { Authorization: `Bearer ${resources.authToken}` }, signal: AbortSignal.timeout(2000),
    });
    expect(heartbeat.status).toBe(421);
    expect(await heartbeat.json()).toEqual({ error: "misdirected", role: "ui" });
    expect(issues.status).toBe(421);
    expect(await issues.json()).toEqual({ error: "misdirected", role: "runtime" });
  }), 10_000);

  it("6. reports each process's actual configured role from /readyz", () => timed(6, async () => {
    for (const [index, role] of ["ui", "runtime"].entries()) {
      const response = await fetch(`${pair[index]!.url}/readyz`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      expect((await response.json() as { role: string }).role).toBe(role);
    }
  }), 10_000);

  it("7. grows A's peer.dropped while B is stopped, then resumes browser delivery after B restarts", () => timed(7, async () => {
    // Restart A with the production channel and its existing small-queue option
    // so actual database writes can overflow it without 10,000 test records.
    await pair[0].call("small-queue");
    await pair[0].ready();
    const socket = await browser();
    try {
      const before = await health(pair[0]);
      await pair[1].stop();
      await pair[0].call("comments", { ...seed, count: 32, label: "peer-down" });
      let down = before;
      await pollUntil(async () => {
        down = await health(pair[0]);
        return down.dropped > before.dropped && down.failed > before.failed;
      }, 5000);
      expect(down.dropped).toBeGreaterThan(before.dropped);
      expect(down.failed).toBeGreaterThan(before.failed);
      await resources.restartRuntime(pair, database.url);
      let resumed = down;
      await pollUntil(async () => {
        resumed = await health(pair[0]);
        return resumed.queued === 0 && resumed.inflight === 0 && resumed.sent > before.sent;
      }, 15_000);
      expect(resumed.queued).toBe(0);
      expect(resumed.inflight).toBe(0);
      expect(resumed.sent).toBeGreaterThan(before.sent);
      // dropped is cumulative; recovery drains the queue, it does not reset it.
      expect(resumed.dropped).toBe(down.dropped);
      const [id] = await pair[1].call<string[]>("comments", { ...seed, count: 1, label: "recovered" });
      const event = await socket.wait("comment:created", (frame) => frame.payload.comment.id === id);
      expect(event?.payload.comment.id).toBe(id);
    } finally { socket.close(); }
  }), 30_000);
});
