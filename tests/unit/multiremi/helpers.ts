/**
 * Shared scaffolding for tests/unit/multiremi/*.test.ts.
 *
 * Every multiremi unit test used to re-declare the same in-memory store
 * bootstrap, `afterEach` teardown, fetch stub and WebSocket await helpers. They
 * now live here once.
 *
 * Usage — two lines at the top of a test file:
 *
 *   import { afterEach } from "bun:test";
 *   import { createStore, resetMultiremiTestEnv } from "./helpers.js";
 *   afterEach(resetMultiremiTestEnv);
 *
 * The `afterEach` registration MUST stay in the test file: Bun evaluates an
 * imported module once per process, so a hook registered at this module's top
 * level would only ever attach to the first test file that imports it.
 *
 * `db` is exported as a live binding (ESM `export let`), so a test that needs to
 * reach past the store and poke the raw sqlite handle can keep writing
 * `db!.run(...)` exactly as it did when the variable was file-local.
 */
import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import { historicalWriters } from "./unified-model-test-backends.js";
import { createId } from "@multiremi/ids.js";
import { createCommitEventQueue, type StoreContext } from '@multiremi/store/context.js';
import type {
  MultiremiAgent,
  MultiremiAgentPlugin,
  MultiremiAutopilot,
  MultiremiAutopilotTrigger,
  MultiremiIssueWorkspaceArchiveBinding,
  CreateIssueInput,
  CreateAutopilotInput,
  MultiremiIssue,
} from "@multiremi/contracts/types.js";

/** The sqlite handle behind the store most recently built by `createStore()`. */
export let db: Database | null = null;
let previousUploadDir: string | undefined;
let uploadDir: string | null = null;
let previousFetch: typeof globalThis.fetch | null = null;

export function createStore(): MultiremiStore {
  db = openSqliteDatabase(":memory:");
  return new MultiremiStore(db);
}

/** An offline snapshot; construct the current Store only after seeding/draining it. */
export function createHistoricalDatabase(): Database {
  db = openSqliteDatabase(":memory:");
  bootstrapPreUnifiedSchema(db);
  historicalWriters(db);
  db.run("UPDATE multiremi_workspace_members SET role='owner' WHERE id='mem_local_local'");
  return db;
}

/** `createStore()` plus the seeded `local` workspace, for surfaces that assume it exists. */
export function createLocalStore(): MultiremiStore {
  const store = createStore();
  store.ensureLocalWorkspace();
  return store;
}

/** Explicit synthetic-human fixture for new Issues, never a Store default or legacy backfill. */
export function createResponsibleTestIssue(store: MultiremiStore, input: CreateIssueInput): MultiremiIssue {
  const parentId=input.parentIssueId??input.parent_issue_id;
  if(parentId || Object.hasOwn(input,'responsibleMemberId') || Object.hasOwn(input,'responsible_member_id')) return store.createIssue(input);
  return store.createIssue({...input,responsibleMemberId:explicitTestHuman(store,input.workspaceId??input.workspace_id??'local').id});
}

function explicitTestHuman(store:MultiremiStore,workspaceId:string) {
  const memberId=`test_root_human_${workspaceId}`;
  const human=store.getWorkspaceMember(memberId)??store.createWorkspaceMember({id:memberId,name:'Explicit test root human',workspaceId,role:'member'});
  if(human.archivedAt || human.workspaceId!==workspaceId)throw new Error('Synthetic fixture human is unavailable; configure an explicit fixture responsibility');
  return human;
}

/** Explicit automation responsibility configuration, scoped to its actual fixture workspace. */
export function createResponsibleTestAutopilot(store:MultiremiStore,input:CreateAutopilotInput):MultiremiAutopilot {
  if(Object.hasOwn(input,'responsibleMemberId')||Object.hasOwn(input,'responsible_member_id'))return store.createAutopilot(input);
  return createResponsibleTestAutopilot(store, {...input,responsibleMemberId:explicitTestHuman(store,input.workspaceId??input.workspace_id??'local').id});
}

/** Close through the real delivery API. Fixtures must explicitly supply an Agent execution owner. */
export function prepareTestIssueDelivery(store: MultiremiStore, issueId: string, summary='Verified fixture delivery') {
  const responsibility=store.resolveIssueResponsibility(issueId);
  if(responsibility.unresolved.length || !responsibility.executionOwner || !responsibility.reviewOwner)throw new Error('Configure a complete test Issue responsibility before accepting its delivery');
  const owner=responsibility.executionOwner;
  const task=store.createTask({agentId:owner.id,issueId:owner.issueId,prompt:summary});
  const delivery=store.submitIssueDelivery(issueId,{summary},{type:'agent',id:owner.id,taskId:task.id});
  if(delivery.reviewUnavailableReason)throw new Error('Reopen the parent before preparing its acceptance fixture');
  const reviewer=responsibility.reviewOwner;
  const reviewerTask=reviewer.type==='agent'?(store.listTasksForIssue(reviewer.issueId).find(candidate=>
    candidate.agentId===reviewer.id&&['queued','running','awaiting_human'].includes(candidate.status)&&!candidate.chatSessionId&&
    !!candidate.issueSessionId&&store.getIssueSession(candidate.issueSessionId)?.inheritMode==='none')
    ??store.createTask({agentId:reviewer.id,issueId:reviewer.issueId,prompt:'Review fixture delivery'})):null;
  return {delivery,executionTask:task,actor:{type:reviewer.type,id:reviewer.id,...(reviewerTask?{taskId:reviewerTask.id}:{})}};
}

export function acceptTestIssueDelivery(store: MultiremiStore, issueId: string, summary='Verified fixture delivery'): MultiremiIssue {
  const {delivery,actor}=prepareTestIssueDelivery(store,issueId,summary);
  store.respondIssueDelivery(issueId,delivery.id,{action:'accept',revision:delivery.responsibilityRevision},actor);
  return store.getIssue(issueId)!;
}

/** Seed a documented pre-responsibility snapshot, never a current business write.
 * No delivery receipt is invented; consumers must still expose legacy gaps. */
export function seedHistoricalIssueFacts(store: MultiremiStore, issueId: string, facts: {
  status?: MultiremiIssue['status']; assigneeType?: MultiremiIssue['assigneeType']; assigneeId?: string|null;
}): MultiremiIssue {
  const issue=store.getIssue(issueId);
  if(!issue)throw new Error('Historical fixture Issue not found');
  const database=(store as unknown as {db:import('@multiremi/store/db/postgres.js').SqlDatabase}).db;
  const columns:Record<string,unknown>={};
  if(Object.hasOwn(facts,'status'))columns.status=facts.status;
  if(Object.hasOwn(facts,'assigneeType'))columns.assignee_type=facts.assigneeType;
  if(Object.hasOwn(facts,'assigneeId'))columns.assignee_id=facts.assigneeId;
  const entries=Object.entries(columns);
  if(entries.length)database.run(`UPDATE multiremi_issues SET ${entries.map(([column])=>`${column}=?`).join(',')} WHERE id=?`,[...entries.map(([,value])=>value),issueId]);
  return store.getIssue(issueId)!;
}

/** A read/upgrade fixture with old member execution or already-closed facts.
 * Never use for current creation, assignment, closing, or acceptance tests. */
export function createHistoricalTestIssue(store: MultiremiStore,input:CreateIssueInput):MultiremiIssue {
  const member=(input.assigneeType??input.assignee_type)==='member';
  const done=input.status==='done';
  const issue=createResponsibleTestIssue(store,{...input,...(member?{assigneeType:null,assignee_type:null,assigneeId:null,assignee_id:null}:{}),...(done?{status:'in_progress'}:{})});
  return seedHistoricalIssueFacts(store,issue.id,{...(member?{assigneeType:'member',assigneeId:input.assigneeId??input.assignee_id??null}:{}),...(done?{status:'done'}:{})});
}

/** Replay a pre-responsibility terminal fact into the notification consumer.
 * This cannot authorize current closure and deliberately creates no delivery receipt. */
export function replayHistoricalTestChildDone(store: MultiremiStore, issueId:string, statusChangeEventId?:string):void {
  const {db:database,ctx}=store as unknown as {db:import('@multiremi/store/db/postgres.js').SqlDatabase;ctx:StoreContext};
  const previous=store.getIssue(issueId)!;
  const events=createCommitEventQueue();
  database.transaction(()=>{
    ctx.lockWorkspaceRuntimeLifecycle(previous.workspaceId);
    const historical=seedHistoricalIssueFacts(store,issueId,{status:'done'});
    ctx.issues().notifyChildStatusChangeWithinTransaction(previous,historical,null,[],events,{statusChangeEventId});
  })();
  ctx.emitCommitEvents(events);
}

export function configureRepositoryWikiAutomation(
  store: MultiremiStore,
  input: {
    workspaceId?: string;
    agent?: MultiremiAgent;
    plugin?: MultiremiAgentPlugin;
    autopilot?: MultiremiAutopilot;
    runtimeId?: string | null;
  } = {},
): {
  agent: MultiremiAgent;
  plugin: MultiremiAgentPlugin;
  autopilot: MultiremiAutopilot;
  trigger: MultiremiAutopilotTrigger;
} {
  const workspaceId = input.workspaceId ?? "local";
  const plugin = input.plugin ?? store.listAgentPlugins(workspaceId, { provider: "claude" })
    .find((candidate) => candidate.name === "code-to-wiki")
    ?? store.importAgentPlugin({
      workspaceId,
      provider: "claude",
      name: "code-to-wiki",
      manifest: { name: "code-to-wiki", version: "1.0.0" },
      files: [{ path: "skills/code-to-wiki/SKILL.md", content: "# Code to Wiki\n" }],
    });
  const agent = input.agent ?? store.createAgent({
    name: "Wiki maintainer",
    provider: "claude",
    workspaceId,
    role: "maintainer",
    runtimeId: input.runtimeId,
  });
  const binding = store.listAgentPluginBindings(agent.id).find((candidate) => candidate.pluginId === plugin.id);
  if (!binding) {
    store.createAgentPluginBinding(agent.id, {
      pluginId: plugin.id,
      versionPolicy: "follow_active",
      enabled: true,
    });
  } else if (!binding.enabled) {
    store.updateAgentPluginBinding(agent.id, binding.id, { enabled: true });
  }
  const autopilot = input.autopilot ?? createResponsibleTestAutopilot(store, {
    title: "Repository Wiki updater",
    workspaceId,
    assigneeId: agent.id,
    executionMode: "run_only",
    status: "active",
  });
  if (store.listScmRepositoryBindings({ workspaceId, enabled: true }).length === 0) {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const repository = {
      id: "repo_wiki_automation_scope",
      name: "wiki-automation-scope",
      url: "git@github.com:multiremi/wiki-automation-scope.git",
      source: "github" as const,
      default_branch: "main",
    };
    if (!workspace.repos.some((candidate) =>
      typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === repository.id
    )) {
      store.updateWorkspaceRepositories(workspaceId, [...workspace.repos, repository]);
    }
    const provider = "github" as const;
    const connection = store.listScmConnections({ workspaceId, provider, enabled: true })[0]
      ?? store.createScmConnection({
        workspaceId,
        name: "Wiki automation test connection",
        provider,
        mode: "poll",
      });
    if (!store.getScmRepositoryBinding(connection.id, repository.id)) {
      store.upsertScmRepositoryBinding({
        workspaceId,
        connectionId: connection.id,
        repositoryId: repository.id,
        repositoryUrl: repository.url,
        repositorySource: repository.source,
        name: repository.name,
        defaultBranch: repository.default_branch,
        enabled: true,
        assignmentOrigin: "explicit",
      });
    }
  }
  let trigger = store.listAutopilotTriggers(autopilot.id).find((candidate) => candidate.kind === "scm_event" && candidate.enabled);
  if (!trigger) {
    trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      enabled: true,
      eventConfig: { resource: "scm", events: ["change.merged", "default_branch.updated"] },
    });
  }
  if (input.runtimeId && plugin.activeVersionId && plugin.activeVersion) {
    store.reportAgentPluginRuntimeState(input.runtimeId, plugin.activeVersionId, {
      status: "ready",
      observedDigest: plugin.activeVersion.artifactDigest,
      retryGeneration: 0,
    });
  }
  return { agent, plugin, autopilot, trigger };
}

export function readyArchiveBinding(
  store: MultiremiStore,
  issueId: string,
  runtimeId: string,
): MultiremiIssueWorkspaceArchiveBinding {
  const existing = store.getSessionArchiveStatus(issueId).latestReady;
  if (existing) {
    return {
      archiveId: existing.id,
      sourceRevision: existing.sourceRevision,
      sha256: existing.sha256,
    };
  }
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
  const archiveId = createId("sar");
  const sourceRevision = `test-${archiveId}`;
  const sha256 = createHash("sha256").update(archiveId).digest("hex");
  const initialized = store.initSessionArchive({
    workspaceId: runtime.workspaceId ?? "local",
    subjectKind: "issue",
    subjectId: issueId,
    issueId,
    runtimeId,
    daemonId: runtime.daemonId ?? "test-daemon",
    sourceRevision,
    sha256,
    sizeBytes: 0,
  }, archiveId, `tests/${archiveId}/sessions.zip`).archive;
  const claimed = store.claimSessionArchiveUploadAttempt(initialized.id, runtimeId);
  if (!claimed) throw new Error("Failed to claim test Session archive");
  const uploading = store.beginSessionArchiveUploadAttempt(
    claimed.id,
    runtimeId,
    claimed.attemptCount,
  );
  if (!uploading) throw new Error("Failed to begin test Session archive upload");
  const ready = store.markSessionArchiveReadyAttempt(
    uploading.id,
    runtimeId,
    uploading.attemptCount,
    0,
  );
  if (!ready) throw new Error("Failed to complete test Session archive");
  return { archiveId: ready.id, sourceRevision: ready.sourceRevision, sha256: ready.sha256 };
}

/**
 * Undo everything the helpers below touch: close the store's database, drop the
 * upload dir and its env var, restore the real `fetch`.
 */
export function resetMultiremiTestEnv(): void {
  db?.close();
  db = null;
  if (uploadDir) {
    rmSync(uploadDir, { recursive: true, force: true });
    uploadDir = null;
    if (previousUploadDir === undefined) delete process.env.MULTIREMI_UPLOAD_DIR;
    else process.env.MULTIREMI_UPLOAD_DIR = previousUploadDir;
    previousUploadDir = undefined;
  }
  if (previousFetch) {
    globalThis.fetch = previousFetch;
    previousFetch = null;
  }
}

export function signTestJwt(payload: Record<string, unknown>, secret = "multiremi-dev-secret-change-in-production"): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function workspaceRepoVersion(urls: string[]): string {
  return createHash("sha256").update([...urls].sort().join("\n")).digest("hex");
}

export function useUploadDir(): string {
  previousUploadDir = process.env.MULTIREMI_UPLOAD_DIR;
  uploadDir = mkdtempSync(join(tmpdir(), "multiremi-upload-"));
  process.env.MULTIREMI_UPLOAD_DIR = uploadDir;
  return uploadDir;
}

export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof globalThis.fetch;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function metricValue(store: MultiremiStore, name: string, labels: Record<string, string>): number {
  return store.listMetricCounters({ name }).find((counter) => {
    const keys = Object.keys(labels);
    return Object.keys(counter.labels).length === keys.length && keys.every((key) => counter.labels[key] === labels[key]);
  })?.value ?? 0;
}

/** Column headers of a Go-style CLI table, for asserting on captured stdout. */
export function tableHeaders(output: string): string[] {
  return output.split("\n")[0]?.trim().split(/\s{2,}/) ?? [];
}

export function nextWebSocketMessage(socket: WebSocket, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), timeoutMs);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    }, { once: true });
  });
}

export function nextWebSocketMessages(socket: WebSocket, count: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timeout = setTimeout(() => done(() => reject(new Error("Timed out waiting for websocket messages"))), 2000);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      fn();
    };
    const onMessage = (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)));
      if (messages.length === count) done(() => resolve(messages));
    };
    const onError = () => done(() => reject(new Error("WebSocket error")));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

export function expectWebSocketRejected(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket rejection")), 2000);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onRejected);
      socket.removeEventListener("error", onRejected);
      fn();
    };
    const onOpen = () => done(() => reject(new Error("WebSocket unexpectedly opened")));
    const onMessage = () => done(() => reject(new Error("WebSocket unexpectedly received a message")));
    const onRejected = () => done(resolve);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("close", onRejected, { once: true });
    socket.addEventListener("error", onRejected, { once: true });
  });
}

export function waitWebSocketOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      fn();
    };
    const onOpen = () => done(resolve);
    const onError = () => done(() => reject(new Error("WebSocket error")));
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

export async function authenticateBrowserWebSocket(socket: WebSocket, token: string): Promise<void> {
  await waitWebSocketOpen(socket);
  socket.send(JSON.stringify({ type: "auth", payload: { token } }));
  expect(await nextWebSocketMessage(socket)).toMatchObject({ type: "auth_ack" });
}

export function expectNoWebSocketMessage(socket: WebSocket, timeoutMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => done(resolve), timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      fn();
    };
    const onMessage = (event: MessageEvent) => done(() => reject(new Error(`Unexpected websocket message: ${String(event.data)}`)));
    const onError = () => done(() => reject(new Error("WebSocket error")));
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}
