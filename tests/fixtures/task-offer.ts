import { DaemonProtocolLayer, type DaemonProtocolIdentity } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers, prepareTaskOffer } from "@multiremi/api/daemon-protocol/task-offers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { createProjectKnowledgeServiceFromEnv, type ProjectKnowledgeServiceContract } from "@multiremi/project-knowledge/service.js";
import { createRepositoryWikiServiceFromEnv, type RepositoryWikiServiceContract } from "@multiremi/repository-wiki/service.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { daemonTaskWireResponse } from "@multiremi/api/wire/tasks.js";
import { compareDaemonPendingTasks } from "@multiremi/api/helpers/tasks.js";

interface TaskOfferFixtureOptions {
  projectKnowledge?: ProjectKnowledgeServiceContract;
  repositoryWiki?: RepositoryWikiServiceContract;
  headers?: HeadersInit;
  authToken?: string;
  reply?: { ok: boolean; code?: string };
}

class OfferUpgradeRejected extends Error {
  constructor(readonly response: Response) { super("Daemon offer upgrade rejected"); }
}

/** Unit-test transport: encoded hello -> production pump -> offer -> encoded accept. */
export async function receiveTaskOffer(store: MultiremiStore, runtimeId: string, options: TaskOfferFixtureOptions = {}): Promise<Record<string, any> | null> {
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
  const layer = new DaemonProtocolLayer({ store });
  const project = options.projectKnowledge ?? createProjectKnowledgeServiceFromEnv(store);
  const wiki = options.repositoryWiki ?? createRepositoryWikiServiceFromEnv(store);
  new DaemonTaskOffers({ store, layer, prepare: task => prepareTaskOffer(store, task, project, wiki) });
  const frames: Record<string, any>[] = [];
  let identity: DaemonProtocolIdentity = { accessToken: null, masterToken: true };
  if (options.headers) {
    const resolved = await layer.resolveIdentity(new Request("http://fixture/api/daemon/ws?protocol=2", { headers: options.headers }), options.authToken ?? "");
    if ("response" in resolved) { layer.stop(); throw new OfferUpgradeRejected(resolved.response); }
    identity = resolved.identity;
  }
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
    identity);
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, daemon_id: runtime.daemonId ?? "dmn_offer_unit", cli_version: DAEMON_MIN_CLI_VERSION, caps: [],
      runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: runtime.maxConcurrency ?? 1, active_task_ids: [] }],
    } }));
    await layer.drain();
    const offer = frames.find(frame => frame.t === "task.offer");
    // A unit observation consumes one offer, not the rest of this runtime's queue.
    layer.stop();
    if (!offer) return null;
    await session.handleMessage(JSON.stringify({ v: 2, t: "res", re: String(offer.seq), ack: offer.seq, p: options.reply ?? { ok: true } }));
    return offer.p;
  } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
}

export async function reconcileRuntimeReady(store: MultiremiStore, runtimeId: string, activeTaskIds: string[] = []): Promise<Record<string, any>[]> {
  const layer = new DaemonProtocolLayer({ store });
  new DaemonTaskOffers({ store, layer, prepare: async () => null });
  layer.stop();
  const runtime = store.getRuntime(runtimeId);
  const frames: Record<string, any>[] = [];
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} },
    { accessToken: null, masterToken: true });
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, daemon_id: runtime?.daemonId ?? "dmn_offer_unit", cli_version: DAEMON_MIN_CLI_VERSION, caps: [],
      runtimes: [{ runtime_id: runtimeId, provider: runtime?.provider ?? "claude", max_concurrency: 1, active_task_ids: activeTaskIds }],
    } }));
    await session.handleMessage(JSON.stringify({ v: 2, t: "runtime.ready", rt: runtimeId, p: { active_task_ids: activeTaskIds } }));
    return frames;
  } finally { layer.closeAll(); layer.stop(); await layer.drain(); }
}

/** Preserve payload assertions while making the test's transport change explicit. */
export async function taskOfferResponse(store: MultiremiStore, runtimeId: string,
  options: Parameters<typeof receiveTaskOffer>[2] = {}): Promise<Response> {
  try { return Response.json({ task: await receiveTaskOffer(store, runtimeId, options) }); }
  catch (error) { if (error instanceof OfferUpgradeRejected) return error.response; throw error; }
}

/** Legacy pending payload assertions belong to the store/wire unit boundary, not a removed route. */
export function pendingTaskWireSnapshot(store: MultiremiStore, runtimeId: string): Record<string, any>[] {
  return store.listTasksForRuntimeStatuses(runtimeId, ["queued", "dispatched"])
    .sort(compareDaemonPendingTasks).map(task => daemonTaskWireResponse(task, store.getTaskTriggerMetadata(task)));
}
