#!/usr/bin/env bun
/**
 * Golden route snapshot for the Multiremi HTTP API.
 *
 * WHY: `createMultiremiApp` registers ~489 routes across two intentionally
 * divergent prefixes (`/api/multiremi/*` native and `/api/*` Go-compat). The
 * api.ts split moves those handlers into per-domain routers. This harness is
 * the oracle for those moves: boot the app over a seeded `:memory:` store,
 * hit every route family on both prefixes, and write one sorted JSON file.
 * After a pure move the file must be BYTE-IDENTICAL. A diff means the move
 * changed behavior — fix the move, never regenerate the baseline.
 *
 *   bun run scripts/snapshot-api-routes.ts            # write the baseline
 *   bun run scripts/snapshot-api-routes.ts --check    # compare against it
 *   bun run scripts/snapshot-api-routes.ts --twice    # prove determinism
 *
 * DETERMINISM
 * -----------
 * Two consecutive runs on the same tree must produce identical bytes. That is
 * achieved by (a) pinning the sources of entropy before the app is built and
 * (b) a normalizer that scrubs whatever entropy is left.
 *
 * Pinned at the source (see `installDeterminism`):
 *   - `crypto.getRandomValues` / `crypto.randomUUID` / `Math.random` → seeded
 *     PRNG, reset at the start of every family, so ids (`createId`) are stable
 *     and a change in one family cannot shift ids in another.
 *   - `new Date()` / `Date.now()` / `performance.now()` → fixed epoch that
 *     advances 1ms per read, so `created_at` ordering is stable (a real clock
 *     can tie two rows in one run and not the next, flipping list order).
 *   - `globalThis.fetch` → canned 503; no route may reach the network.
 *   - env vars that leak into bodies (upload dir, release dir, public URL,
 *     GitHub/Lark app config, NODE_ENV) → fixed values.
 *   - explicit ids passed to every store create that accepts one.
 *
 * Scrubbed by the normalizer (see `NORMALIZER_RULES`): values are replaced IN
 * PLACE with a placeholder of the same type — presence and type are always
 * preserved, fields are never dropped.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { listAgentTemplates } from "@multiremi/api/agent-templates.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { VERSION } from "@shared/version.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const GOLDEN_PATH = join(REPO_ROOT, "scripts", "api-routes.golden.json");

const SNAPSHOT_TMP = join(tmpdir(), "multiremi-api-snapshot");
const UPLOAD_DIR = join(SNAPSHOT_TMP, "uploads");
const RELEASE_DIR = join(SNAPSHOT_TMP, "releases");
const SCRIPTS_DIR = join(SNAPSHOT_TMP, "release-scripts");

/** Routes that cannot be driven through `app.request` (WebSocket upgrade). */
const STATUS_ONLY_ROUTES = new Set([
  "GET /ws",
  "GET /api/daemon/ws",
  "GET /api/realtime/ws",
]);

const NORMALIZER_RULES = [
  "ISO-8601 timestamps (anywhere in a string) -> \"<timestamp>\"",
  "local timestamp ids (local[-contact|-lark]-<epoch>) -> \"<timestamp>\" suffix",
  "epoch-millisecond numbers (1.5e12..4e12) and *_ms/duration/elapsed/uptime/latency numeric keys -> 0",
  "absolute machine paths (repo root, $HOME, $TMPDIR, upload dir) -> \"<repo>\"/\"<home>\"/\"<tmp>\"/\"<uploads>\"",
  "hostname in URL/UNC authorities -> \"<hostname>\"; username in Unix/Windows home paths -> \"<user>\"",
  "package VERSION -> \"<version>\"",
  "non-JSON bodies larger than 2000 bytes -> { __body__: { contentType, bytes, sha256 } }",
];

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

const FIXED_EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
let prngState = 0x1234abcd;
let clock = FIXED_EPOCH;
let uuidCounter = 0;

function nextByte(): number {
  // xorshift32 — small, fast, fully deterministic from `prngState`.
  prngState ^= prngState << 13;
  prngState ^= prngState >>> 17;
  prngState ^= prngState << 5;
  prngState |= 0;
  return (prngState >>> 24) & 0xff;
}

/** Reset the PRNG + clock so each family starts from the same state. */
function resetDeterministicState(): void {
  prngState = 0x1234abcd;
  clock = FIXED_EPOCH;
  uuidCounter = 0;
}

function installDeterminism(): () => void {
  const realGetRandomValues = globalThis.crypto.getRandomValues;
  const realRandomUUID = globalThis.crypto.randomUUID;
  const realDate = globalThis.Date;
  const realMathRandom = Math.random;
  const realPerformanceNow = globalThis.performance.now;
  const realFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string | undefined): void {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  (globalThis.crypto as any).getRandomValues = (array: any) => {
    for (let i = 0; i < array.length; i++) array[i] = nextByte();
    return array;
  };
  (globalThis.crypto as any).randomUUID = () => {
    const n = (uuidCounter++).toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${n}`;
  };

  class SnapshotDate extends realDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(clock++);
      else super(...(args as [any]));
    }
    static now(): number {
      return clock++;
    }
  }
  (globalThis as any).Date = SnapshotDate;
  Math.random = () => {
    return nextByte() / 256;
  };
  (globalThis.performance as any).now = () => clock - FIXED_EPOCH;

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "network disabled in the api snapshot harness" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;

  rmSync(SNAPSHOT_TMP, { recursive: true, force: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  mkdirSync(RELEASE_DIR, { recursive: true });
  mkdirSync(SCRIPTS_DIR, { recursive: true });

  setEnv("MULTIREMI_TOKEN", undefined); // auth middleware off: snapshot handler bodies
  setEnv("MULTIREMI_DATABASE_URL", undefined); // never touch a real Postgres
  setEnv("NODE_ENV", "test");
  setEnv("MULTIREMI_UPLOAD_DIR", UPLOAD_DIR);
  setEnv("MULTIREMI_RELEASE_DIR", RELEASE_DIR);
  setEnv("MULTIREMI_SCRIPTS_DIR", SCRIPTS_DIR);
  setEnv("MULTIREMI_RELEASE_REPO", "Grassgod/remi");
  setEnv("MULTIREMI_PUBLIC_URL", "https://snapshot.invalid");
  setEnv("MULTIREMI_ALLOW_EMAIL_CODE_LOGIN", "1");
  setEnv("MULTIREMI_LOCAL_AUTH_CODE", "424242");
  setEnv("MULTIREMI_LARK_APP_ID", "cli_snapshot");
  setEnv("MULTIREMI_LARK_APP_SECRET", "snapshot-lark-secret");
  setEnv("MULTIREMI_LARK_DOMAIN", "https://open.feishu.cn");
  setEnv("MULTIREMI_WEBHOOK_SECRET", "snapshot-webhook-secret");
  setEnv("GOOGLE_CLIENT_ID", "snapshot-google-client");
  setEnv("POSTHOG_API_KEY", undefined);
  setEnv("POSTHOG_HOST", undefined);
  setEnv("ANALYTICS_DISABLED", undefined);
  setEnv("JWT_SECRET", undefined);

  resetDeterministicState();

  return () => {
    globalThis.crypto.getRandomValues = realGetRandomValues;
    (globalThis.crypto as any).randomUUID = realRandomUUID;
    (globalThis as any).Date = realDate;
    Math.random = realMathRandom;
    (globalThis.performance as any).now = realPerformanceNow;
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(SNAPSHOT_TMP, { recursive: true, force: true });
  };
}

// ---------------------------------------------------------------------------
// normalizer
// ---------------------------------------------------------------------------

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})/g;
const LOCAL_TIME_ID_RE = /\b(local(?:-contact|-lark)?)-\d{13}\b/g;
const TIME_KEY_RE = /(^|_)(duration|elapsed|uptime|latency)(_ms|_seconds)?$/i;
const MS_KEY_RE = /_ms$/i;

const PATH_REPLACEMENTS: Array<[string, string]> = [
  [UPLOAD_DIR, "<uploads>"],
  [SNAPSHOT_TMP, "<tmp>"],
  [REPO_ROOT, "<repo>"],
  [tmpdir(), "<tmp>"],
  [homedir(), "<home>"],
];

export interface SnapshotMachineIdentity {
  hostname?: string;
  username?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubPathIdentity(
  value: string,
  identity: SnapshotMachineIdentity,
): string {
  let out = value;
  const host = identity.hostname ?? hostname();
  if (host && host.length > 2) {
    const authority = new RegExp(`((?:https?:)?[/\\\\]{2})${escapeRegExp(host)}(?=[:/\\\\]|$)`, "g");
    out = out.replace(authority, (_match, prefix: string) => `${prefix}<hostname>`);
  }
  const user = identity.username ?? userInfo().username;
  if (user && user.length > 2) {
    const homePath = new RegExp(`((?:^|[/\\\\])(?:home|Users)[/\\\\])${escapeRegExp(user)}(?=[/\\\\]|$)`, "g");
    out = out.replace(homePath, (_match, prefix: string) => `${prefix}<user>`);
  }
  return out;
}

export function scrubString(value: string, identity: SnapshotMachineIdentity = {}): string {
  let out = value
    .replace(ISO_RE, "<timestamp>")
    .replace(LOCAL_TIME_ID_RE, "$1-<timestamp>");
  for (const [needle, replacement] of PATH_REPLACEMENTS) {
    if (needle && out.includes(needle)) out = out.split(needle).join(replacement);
  }
  out = scrubPathIdentity(out, identity);
  if (VERSION && out.includes(VERSION)) out = out.split(VERSION).join("<version>");
  return out;
}

function normalize(value: unknown, key = ""): unknown {
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number") {
    if (TIME_KEY_RE.test(key) || MS_KEY_RE.test(key)) return 0;
    if (Number.isFinite(value) && value >= 1_500_000_000_000 && value <= 4_000_000_000_000) return 0;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) out[entryKey] = normalize(entryValue, entryKey);
    return out;
  }
  return value;
}

async function normalizeBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    try {
      return normalize(JSON.parse(text));
    } catch {
      return { __body__: { contentType, parseError: true, text: scrubString(text) } };
    }
  }
  if (text.length === 0) return "";
  if (text.length <= 2000) return { __body__: { contentType, text: scrubString(text) } };
  return {
    __body__: {
      contentType,
      bytes: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}

// ---------------------------------------------------------------------------
// route table
// ---------------------------------------------------------------------------

export interface RouteRef {
  method: string;
  path: string;
}

function routeTable(app: any): RouteRef[] {
  const seen = new Set<string>();
  const out: RouteRef[] = [];
  for (const route of app.routes as RouteRef[]) {
    if (route.method === "ALL") continue; // middleware, not a route
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: route.method, path: route.path });
  }
  out.sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  return out;
}

function patternRegex(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

/** Best-effort reverse lookup: concrete request path -> registered pattern. */
function matchPattern(routes: RouteRef[], method: string, path: string): string | null {
  let best: { pattern: string; score: number } | null = null;
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.path.split("/").length !== path.split("/").length) continue;
    if (!patternRegex(route.path).test(path)) continue;
    // Hono prefers static segments over params; score statics by position.
    const segments = route.path.split("/");
    let score = 0;
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i].startsWith(":")) score += segments.length - i;
    }
    if (!best || score > best.score) best = { pattern: route.path, score };
  }
  return best?.pattern ?? null;
}

// ---------------------------------------------------------------------------
// seeding
// ---------------------------------------------------------------------------

export interface SeedRefs {
  workspaceId: string;
  otherWorkspaceId: string;
  userId: string;
  memberId: string;
  otherMemberId: string;
  agentId: string;
  archivedAgentId: string;
  skillId: string;
  skillFileId: string;
  runtimeId: string;
  projectId: string;
  repositoryId: string;
  projectResourceId: string;
  projectDocRef: string;
  squadId: string;
  issueId: string;
  childIssueId: string;
  blockedIssueId: string;
  commentId: string;
  labelId: string;
  attachmentId: string;
  issueSessionId: string;
  chatSessionId: string;
  chatMessageId: string;
  taskId: string;
  autopilotId: string;
  triggerId: string;
  webhookToken: string;
  autopilotRunId: string;
  deliveryId: string;
  tokenId: string;
  inboxItemId: string;
  inboxMemberId: string;
  humanRequestId: string;
  runtimeModelRequestId: string;
  dirScanRequestId: string;
  localSkillListRequestId: string;
  localSkillImportRequestId: string;
  runtimeUpdateRequestId: string;
  runtimeCommandRequestId: string;
  runtimeProvisionId: string;
  dependencyId: string;
  invitationId: string;
  templateSlug: string;
  metadataKey: string;
}

async function seedStore(store: MultiremiStore, db: Database): Promise<SeedRefs> {
  const workspaceId = "local";
  store.ensureLocalWorkspace();
  store.updateWorkspace(workspaceId, {
    repos: [
      {
        id: "repo_snapshot",
        name: "snapshot",
        url: "https://example.invalid/snapshot.git",
        source: "github",
      },
      {
        id: "repo_snapshot_compat",
        name: "compat",
        url: "https://example.invalid/compat.git",
        source: "github",
      },
      {
        id: "repo_snapshot_native",
        name: "native",
        url: "https://example.invalid/native.git",
        source: "github",
      },
    ],
  });
  const other = store.createWorkspace({ id: "ws_snapshot", name: "Snapshot Workspace", slug: "snapshot", issuePrefix: "SNAP" });
  const user = store.getCurrentUser();

  const member = store.createWorkspaceMember({
    id: "mem_snapshot_one",
    workspaceId,
    userId: user.id,
    name: "Snapshot Member",
    email: "member@snapshot.invalid",
    role: "admin",
  });
  const otherMember = store.createWorkspaceMember({
    id: "mem_snapshot_two",
    workspaceId,
    userId: "usr_snapshot_two",
    name: "Second Member",
    email: "second@snapshot.invalid",
    role: "member",
  });

  const runtime = store.registerRuntime({
    id: "rt_snapshot",
    name: "snapshot-runtime",
    provider: "claude",
    daemonId: "dmn_snapshot",
    workspaceId,
    ownerId: "local",
    visibility: "public",
    // Roomy enough that the daemon flow can claim its own task even though the
    // seeded chat session already holds one dispatch slot.
    maxConcurrency: 6,
  });

  const skill = store.createSkill({
    id: "skl_snapshot",
    workspaceId,
    name: "snapshot-skill",
    description: "Snapshot skill",
    content: "# snapshot skill",
    files: [{ id: "skf_snapshot", path: "reference.md", content: "snapshot reference" }],
  });
  const skillId = skill.id ?? "skl_snapshot"; // MultiremiSkill.id is optional in the contract
  const skillFile = store.listSkillFiles(skillId)[0] ?? null;

  const agent = store.createAgent({
    id: "agt_snapshot",
    name: "Snapshot Agent",
    provider: "claude",
    workspaceId,
    ownerId: "local",
    runtimeId: runtime.id,
    instructions: "Be deterministic.",
    model: "claude-sonnet-4",
    // Same reason as the runtime's maxConcurrency: the per-agent dispatch cap
    // otherwise starves the daemon flow's own task.
    maxConcurrentTasks: 6,
    customEnv: { SNAPSHOT: "1" },
    allowedTools: ["Read"],
  });
  store.setAgentSkills(agent.id, [skillId]);
  const archivedAgent = store.createAgent({
    id: "agt_snapshot_archived",
    name: "Archived Agent",
    provider: "codex",
    workspaceId,
    ownerId: "local",
  });
  store.archiveAgent(archivedAgent.id);

  const project = store.createProject({ id: "prj_snapshot", title: "Snapshot Project", description: "Project used by the snapshot" });
  const projectResource = store.createProjectResource(project.id, {
    id: "prs_snapshot",
    resourceType: "github_repo",
    resourceRef: { url: "https://example.invalid/snapshot.git" },
    label: "snapshot repo",
  });
  store.createProjectDoc(project.id, {
    id: "pdoc_snapshot",
    kind: "wiki",
    slug: "spec",
    title: "Snapshot Spec",
    body: "# spec",
    tags: ["snapshot"],
  });

  const squad = store.createSquad({
    id: "sqd_snapshot",
    name: "Snapshot Squad",
    description: "Squad used by the snapshot",
    workspaceId,
    leaderId: agent.id,
  });
  store.addSquadMember(squad.id, { memberType: "agent", memberId: agent.id, role: "leader" });

  const label = store.createLabel({ id: "lbl_snapshot", workspaceId, name: "snapshot", color: "#3366ff" });

  const issue = store.createIssue({
    id: "iss_snapshot",
    title: "Snapshot issue",
    description: "Issue used by the snapshot",
    workspaceId,
    projectId: project.id,
    status: "in_progress",
    priority: "high",
    assigneeType: "agent",
    assigneeId: agent.id,
    createdBy: member.id,
  });
  const childIssue = store.createIssue({
    id: "iss_snapshot_child",
    title: "Snapshot child issue",
    workspaceId,
    parentIssueId: issue.id,
    createdBy: member.id,
  });
  const blockedIssue = store.createIssue({
    id: "iss_snapshot_blocked",
    title: "Snapshot blocked issue",
    workspaceId,
    createdBy: member.id,
  });
  store.attachLabelToIssue(issue.id, label.id);
  store.setIssueMetadataKey(issue.id, "snapshot_key", "snapshot_value");
  store.addIssueReaction(issue.id, { actorType: "member", actorId: member.id, emoji: "+1" });
  store.addIssueSubscriber(issue.id, member.id, "manual");
  const dependency = store.createIssueDependency(issue.id, { id: "dep_snapshot", dependsOnIssueId: blockedIssue.id, type: "blocks" });

  const issueSession = store.createIssueSession(issue.id, {
    id: "ise_snapshot",
    title: "Snapshot session",
    createdByType: "member",
    createdById: member.id,
    participantAgentIds: [agent.id],
  });
  store.appendSessionEvent(issueSession.id, {
    type: "message",
    authorType: "member",
    authorId: member.id,
    body: "Snapshot session message",
  } as any);
  store.publishSessionResult(issueSession.id, {
    title: "Snapshot result",
    body: "Snapshot session result body",
    publishedByType: "agent",
    publishedById: agent.id,
  });

  const task = store.createTask({
    id: "tsk_snapshot",
    agentId: agent.id,
    issueId: issue.id,
    workspaceId,
    prompt: "Snapshot prompt",
    runtimeId: runtime.id,
  });
  store.claimTask(runtime.id);
  store.startTask(task.id);
  store.appendTaskMessages(task.id, [{ type: "assistant", content: "working" }]);
  store.reportProgress(task.id, "halfway", 1, 2);
  store.reportTaskUsage(task.id, [{ model: "claude-sonnet-4", inputTokens: 10, outputTokens: 5 } as any]);
  const humanRequest = store.createTaskHumanRequest({
    id: "hrq_snapshot",
    taskId: task.id,
    kind: "permission",
    payload: { tool: "Bash", command: "ls" },
  });
  store.completeTask(task.id, { result: "done", summary: "Snapshot task complete" } as any);

  // Created after the task above: the issue is assigned to `agent`, so this
  // un-mentioned member comment auto-queues an assignee task — seeded earlier
  // it would win the claim race for `task` and break the seed.
  const comment = store.createIssueComment(issue.id, {
    authorType: "member",
    authorId: member.id,
    body: "Snapshot comment body",
  });
  store.addCommentReaction(comment.id, { actorType: "member", actorId: member.id, emoji: "eyes" });

  const attachment = store.createAttachment({
    id: "att_snapshot",
    workspaceId,
    issueId: issue.id,
    commentId: comment.id,
    uploaderType: "member",
    uploaderId: "local",
    filename: "snapshot.txt",
    url: "/api/attachments/att_snapshot/content",
    contentType: "text/plain",
    sizeBytes: 18,
  });
  // Mirrors uploadRelativePath() in api.ts so the content/download routes serve
  // a real file instead of 404-ing.
  mkdirSync(join(UPLOAD_DIR, workspaceId), { recursive: true });
  writeFileSync(join(UPLOAD_DIR, workspaceId, `${attachment.id}.txt`), "snapshot attachment");

  // Created after the task above: sendChatMessage enqueues its own task, and a
  // queued chat task would win the claim race for `task` and break the seed.
  const chatSession = store.createChatSession({
    id: "cht_snapshot",
    agentId: agent.id,
    workspaceId,
    // "local" is the request user id for an unauthenticated request, and chat
    // reads are creator-gated — any other creator turns every chat GET into 403.
    creatorId: "local",
    title: "Snapshot chat",
  });
  const chatMessage = store.sendChatMessage(chatSession.id, { body: "Snapshot chat message" });

  const autopilot = store.createAutopilot({
    id: "apl_snapshot",
    title: "Snapshot autopilot",
    description: "Autopilot used by the snapshot",
    workspaceId,
    projectId: project.id,
    assigneeType: "agent",
    assigneeId: agent.id,
    executionMode: "create_issue",
    issueTitleTemplate: "Snapshot {{title}}",
  });
  const trigger = store.createAutopilotTrigger(autopilot.id, { kind: "webhook", provider: "github", label: "snapshot trigger" });
  const run = store.runAutopilot(autopilot.id, { source: "manual", prompt: "snapshot run" });
  store.handleAutopilotWebhook(autopilot.id, {
    provider: "github",
    event: "issues",
    payload: { action: "opened" },
    rawBody: JSON.stringify({ action: "opened" }),
    headers: { "x-github-event": "issues" },
  } as any);
  const delivery = store.listWebhookDeliveries(autopilot.id)[0];

  const token = (await store.createAccessToken({ id: "tok_snapshot", workspaceId, name: "Snapshot token", type: "pat" })) as any;

  const modelRequest = store.createRuntimeModelListRequest(runtime.id);
  const dirScan = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "/snapshot", maxDepth: 2, mode: "scan" });
  const localSkillList = store.createRuntimeLocalSkillListRequest(runtime.id);
  const localSkillImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "snapshot-skill", name: "Snapshot skill" });
  const runtimeUpdate = store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9", scope: "agent" as any });
  const runtimeCommandRequestId = "rcm_snapshot";
  const runtimeProvisionId = "prov_snapshot";
  db.run(
    `INSERT INTO multiremi_runtime_command_requests (
      id, runtime_id, command, args, redacted_command, redacted_args, timeout_ms,
      created_by, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      runtimeCommandRequestId,
      runtime.id,
      "printf snapshot",
      "[]",
      "printf snapshot",
      "[]",
      1_000,
      member.userId ?? member.id,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  );
  db.run(
    `INSERT INTO multiremi_workspace_runtime_provisions (
      id, workspace_id, kind, enabled, version_check, command, args, redacted_command, redacted_args,
      trigger_kinds, timezone, timeout_ms, created_by, created_at, updated_at
    ) VALUES (?, ?, 'command', 0, 0, ?, '[]', ?, '[]', '[]', 'UTC', 1000, ?, ?, ?)`,
    [
      runtimeProvisionId,
      workspaceId,
      "printf provision-snapshot",
      "printf provision-snapshot",
      member.userId ?? member.id,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  );
  store.updateRuntimeModels(runtime.id, [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" } as any]);
  store.heartbeatRuntime(runtime.id);

  const invitation = store.createWorkspaceInvitation(workspaceId, { email: "invitee@snapshot.invalid", role: "member" });

  store.createFeedback({ id: "fbk_snapshot", message: "Snapshot feedback", workspaceId, userId: user.id, memberId: member.id });
  // Assigning to the local user is what fills the inbox the API reads for an
  // unauthenticated request (compatibilityInboxMemberId -> "local").
  store.assignIssue(blockedIssue.id, { assigneeType: "member", assigneeId: "local" } as any);
  const inboxMemberId = store.listWorkspaceMembers(workspaceId).find((entry) => entry.userId === "local")?.id ?? member.id;
  const inboxItem = store.listInboxItems(inboxMemberId)[0];

  return {
    workspaceId,
    otherWorkspaceId: other.id,
    userId: user.id,
    memberId: member.id,
    otherMemberId: otherMember.id,
    agentId: agent.id,
    archivedAgentId: archivedAgent.id,
    skillId,
    skillFileId: skillFile?.id ?? "skf_snapshot",
    runtimeId: runtime.id,
    projectId: project.id,
    repositoryId: "repo_snapshot",
    projectResourceId: projectResource.id,
    projectDocRef: "spec",
    squadId: squad.id,
    issueId: issue.id,
    childIssueId: childIssue.id,
    blockedIssueId: blockedIssue.id,
    commentId: comment.id,
    labelId: label.id,
    attachmentId: attachment.id,
    issueSessionId: issueSession.id,
    chatSessionId: chatSession.id,
    chatMessageId: (chatMessage as any)?.message?.id ?? (chatMessage as any)?.id ?? "msg_snapshot",
    taskId: task.id,
    autopilotId: autopilot.id,
    triggerId: trigger.id,
    webhookToken: (trigger as any).webhookToken ?? (trigger as any).webhook_token ?? "wht_snapshot",
    autopilotRunId: run.id,
    deliveryId: delivery?.id ?? "whd_snapshot",
    tokenId: token.id,
    inboxItemId: inboxItem?.id ?? "inb_snapshot",
    inboxMemberId,
    humanRequestId: (humanRequest as any).id ?? (humanRequest as any).requestId ?? "hrq_snapshot",
    runtimeModelRequestId: (modelRequest as any).id ?? (modelRequest as any).requestId,
    dirScanRequestId: (dirScan as any).id ?? (dirScan as any).requestId,
    localSkillListRequestId: (localSkillList as any).id ?? (localSkillList as any).requestId,
    localSkillImportRequestId: (localSkillImport as any).id ?? (localSkillImport as any).requestId,
    runtimeUpdateRequestId: (runtimeUpdate as any).id ?? (runtimeUpdate as any).requestId,
    runtimeCommandRequestId,
    runtimeProvisionId,
    dependencyId: dependency.id,
    invitationId: invitation.id,
    templateSlug: listAgentTemplates()[0]?.slug ?? "unknown-template",
    metadataKey: "snapshot_key",
  };
}

// ---------------------------------------------------------------------------
// path parameter resolution
// ---------------------------------------------------------------------------

/** `:id` resolves from the collection segment right before it. */
const ID_BY_COLLECTION: Record<string, keyof SeedRefs> = {
  agents: "agentId",
  "agent-templates": "templateSlug",
  attachments: "attachmentId",
  autopilots: "autopilotId",
  chats: "chatSessionId",
  comments: "commentId",
  inbox: "inboxItemId",
  invitations: "invitationId",
  issues: "issueId",
  labels: "labelId",
  members: "memberId",
  projects: "projectId",
  runtimes: "runtimeId",
  skills: "skillId",
  squads: "squadId",
  tasks: "taskId",
  tokens: "tokenId",
  workspaces: "workspaceId",
};

const BY_NAME: Record<string, keyof SeedRefs> = {
  attachmentId: "attachmentId",
  chatSessionId: "chatSessionId",
  dependencyId: "dependencyId",
  deliveryId: "deliveryId",
  invitationId: "invitationId",
  issueId: "issueId",
  labelId: "labelId",
  memberId: "memberId",
  projectId: "projectId",
  repositoryId: "repositoryId",
  resourceId: "projectResourceId",
  runId: "autopilotRunId",
  runtimeId: "runtimeId",
  provisionId: "runtimeProvisionId",
  squadId: "squadId",
  taskId: "taskId",
  triggerId: "triggerId",
  updateId: "runtimeUpdateRequestId",
  workspaceId: "workspaceId",
};

function resolveParam(pattern: string, name: string, refs: SeedRefs): string {
  switch (name) {
    case "digest":
      return "0".repeat(64);
    case "versionId":
      return "apv_snapshot";
    case "bindingId":
      return "apb_snapshot";
    case "daemonId":
      return "dmn_snapshot";
    case "connectionId":
      return "scm_snapshot";
    case "eventId":
      return "sce_snapshot";
    case "engine":
      return "claude";
    case "key":
      return refs.metadataKey;
    case "slug":
      return refs.templateSlug;
    case "tag":
      return "v9.9.9";
    case "filename":
      return "remi-9.9.9-linux-x64.tar.gz";
    case "ref":
      return refs.projectDocRef;
    case "token":
      return refs.webhookToken;
    case "installationId":
      return "inst_snapshot";
    case "fileId":
      return refs.skillFileId;
    case "itemType":
      return "issue";
    case "itemId":
      return refs.issueId;
    case "participantType":
      return "agent";
    case "participantId":
      return refs.agentId;
    case "archiveId":
      return "sar_snapshot";
    case "requestId":
      if (pattern.includes("/human-requests/")) return refs.humanRequestId;
      if (pattern.includes("/commands/")) return refs.runtimeCommandRequestId;
      if (pattern.includes("/local-skills/import/")) return refs.localSkillImportRequestId;
      if (pattern.includes("/local-skills/")) return refs.localSkillListRequestId;
      if (pattern.includes("/directory-scans/")) return refs.dirScanRequestId;
      if (pattern.includes("/models/")) return refs.runtimeModelRequestId;
      break;
    case "sessionId":
      if (pattern.includes("/lark/install/")) return "lark_snapshot_session";
      if (pattern.includes("/cloud-billing/")) return "cs_snapshot";
      if (pattern.includes("/issues/") || pattern.includes("/sessions/")) {
        return pattern.includes("/chat/sessions/") || pattern.includes("/chat-sessions/")
          ? refs.chatSessionId
          : refs.issueSessionId;
      }
      if (pattern.includes("/chat")) return refs.chatSessionId;
      break;
    case "id": {
      const segments = pattern.split("/");
      const index = segments.indexOf(":id");
      const collection = segments[index - 1];
      if (collection === "agent-plugins") return "apl_snapshot";
      const key = ID_BY_COLLECTION[collection];
      if (key) return String(refs[key]);
      break;
    }
    default:
      break;
  }
  const byName = BY_NAME[name];
  if (byName) return String(refs[byName]);
  throw new Error(`snapshot harness: unresolved path param :${name} in ${pattern}`);
}

/** GET routes whose handler needs a query string to return a real body. */
function getQuery(pattern: string, refs: SeedRefs): string {
  switch (pattern) {
    case "/api/issues/search":
    case "/api/multiremi/issues/search":
    case "/api/projects/search":
    case "/api/multiremi/projects/search":
      return "?q=snapshot";
    case "/api/skills/search":
    case "/api/multiremi/skills/search":
      return "?q=snapshot&query=snapshot";
    case "/auth/lark/url":
      return "?redirect_uri=https%3A%2F%2Fsnapshot.invalid%2Fcallback";
    case "/api/inbox":
    case "/api/inbox/unread-count":
      return `?member_id=${encodeURIComponent(refs.inboxMemberId)}`;
    case "/api/multiremi/inbox":
      return `?memberId=${encodeURIComponent(refs.inboxMemberId)}`;
    case "/api/multiremi/daemons/:daemonId/retirement-plan":
      return `?workspace_id=${encodeURIComponent(refs.workspaceId)}`;
    default:
      return "";
  }
}

function concretePath(pattern: string, refs: SeedRefs): string {
  const path = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? encodeURIComponent(resolveParam(pattern, segment.slice(1), refs)) : segment))
    .join("/");
  return `${path}${getQuery(pattern, refs)}`;
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  key: string;
  route: string;
  path: string;
  status: number | string;
  body: unknown;
}

class Recorder {
  readonly entries: SnapshotEntry[] = [];
  readonly covered = new Set<string>();
  private step = 0;

  constructor(private readonly app: any, private readonly routes: RouteRef[], private readonly family: string) {}

  async call(method: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const [rawPath] = path.split("?");
    const route = matchPattern(this.routes, method, rawPath) ?? rawPath;
    this.covered.add(`${method} ${route}`);
    const key = `${this.family}#${String(this.step++).padStart(3, "0")} ${method} ${route}`;
    let response: Response;
    try {
      response = await this.app.request(path, { method, ...init });
    } catch (error) {
      this.entries.push({
        key,
        route: `${method} ${route}`,
        path: scrubString(path),
        status: "threw",
        body: { error: scrubString(String((error as Error).message ?? error)) },
      });
      return { status: 0, body: null };
    }
    const clone = response.clone();
    this.entries.push({
      key,
      route: `${method} ${route}`,
      path: scrubString(path),
      status: response.status,
      body: await normalizeBody(response),
    });
    let parsed: any = null;
    try {
      parsed = await clone.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }

  json(method: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
    return this.call(method, path, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function buildApp(): Promise<{ app: any; store: MultiremiStore; db: Database; refs: SeedRefs }> {
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  const refs = await seedStore(store, db);
  const app = createMultiremiApp({ store, realtimeState: { enabled: true, connections: 0 } });
  return { app, store, db, refs };
}

// ---------------------------------------------------------------------------
// families
// ---------------------------------------------------------------------------

type Flow = (rec: Recorder, refs: SeedRefs) => Promise<void>;

const MUTATION_FLOWS: Array<{ name: string; run: Flow }> = [];

function flow(name: string, run: Flow): void {
  MUTATION_FLOWS.push({ name, run });
}

// -- agents -----------------------------------------------------------------
flow("agents-compat", async (rec, refs) => {
  const created = await rec.json("POST", "/api/agents", {
    name: "Compat Agent",
    provider: "claude",
    workspace_id: refs.workspaceId,
    runtime_id: refs.runtimeId,
    instructions: "compat",
    max_concurrent_tasks: 3,
  });
  const id = created.body?.id ?? refs.agentId;
  await rec.json("PUT", `/api/agents/${id}`, { name: "Compat Agent Renamed", model: "claude-opus-4" });
  await rec.json("PUT", `/api/agents/${id}/env`, { custom_env: { A: "1" } });
  await rec.json("PUT", `/api/agents/${id}/skills`, { skill_ids: [refs.skillId] });
  await rec.json("POST", `/api/agents/${id}/skills/add`, { skill_ids: [refs.skillId] });
  await rec.json("POST", `/api/agents/${id}/cancel-tasks`, {});
  await rec.json("POST", `/api/agents/${id}/archive`, {});
  await rec.json("POST", `/api/agents/${id}/restore`, {});
  await rec.json("POST", "/api/agents/from-template", { template_slug: refs.templateSlug, name: "From Template" });
});

flow("agents-native", async (rec, refs) => {
  const created = await rec.json("POST", "/api/multiremi/agents", {
    name: "Native Agent",
    provider: "codex",
    workspaceId: refs.workspaceId,
    runtimeId: refs.runtimeId,
  });
  const id = created.body?.id ?? refs.agentId;
  await rec.json("PATCH", `/api/multiremi/agents/${id}`, { name: "Native Agent Renamed" });
  await rec.json("PUT", `/api/multiremi/agents/${id}/skills`, { skillIds: [refs.skillId] });
  await rec.json("POST", "/api/multiremi/agents/default", { provider: "claude", workspaceId: refs.workspaceId });
  await rec.json("POST", "/api/multiremi/agents/from-template", { templateSlug: refs.templateSlug, name: "Native From Template" });
  await rec.json("DELETE", `/api/multiremi/agents/${id}`, {});
});

// -- skills -----------------------------------------------------------------
flow("skills-compat", async (rec, refs) => {
  const created = await rec.json("POST", "/api/skills", {
    name: "compat-skill",
    description: "compat",
    content: "# compat",
    workspace_id: refs.workspaceId,
  });
  const id = created.body?.id ?? refs.skillId;
  await rec.json("PUT", `/api/skills/${id}`, { name: "compat-skill-renamed" });
  await rec.json("PATCH", `/api/skills/${id}`, { name: "compat-skill-patched" });
  const file = await rec.json("PUT", `/api/skills/${id}/files`, { path: "extra.md", content: "extra" });
  const fileId = file.body?.id ?? refs.skillFileId;
  await rec.call("DELETE", `/api/skills/${id}/files/${fileId}`);
  await rec.json("POST", "/api/skills/import", { url: "https://github.com/example/skill" });
  await rec.call("DELETE", `/api/skills/${id}`);
});

flow("skills-native", async (rec, refs) => {
  const created = await rec.json("POST", "/api/multiremi/skills", {
    name: "native-skill",
    workspaceId: refs.workspaceId,
    content: "# native",
  });
  const id = created.body?.id ?? refs.skillId;
  await rec.json("PATCH", `/api/multiremi/skills/${id}`, { name: "native-skill-patched" });
  await rec.json("PUT", `/api/multiremi/skills/${id}`, { name: "native-skill-put" });
  await rec.json("POST", "/api/multiremi/skills/import", { sourceUrl: "https://github.com/example/skill" });
  await rec.call("DELETE", `/api/multiremi/skills/${id}`);
});

// -- issues -----------------------------------------------------------------
flow("issues-compat", async (rec, refs) => {
  const created = await rec.json("POST", "/api/issues", {
    title: "Compat issue",
    description: "created by the snapshot",
    workspace_id: refs.workspaceId,
    project_id: refs.projectId,
    priority: "medium",
  });
  const id = created.body?.id ?? refs.issueId;
  await rec.json("PUT", `/api/issues/${id}`, { title: "Compat issue renamed", status: "in_progress" });
  await rec.json("PATCH", `/api/issues/${id}`, { priority: "urgent", assignee_type: "squad", assignee_id: refs.squadId });
  await rec.json("POST", "/api/issues/quick-create", {
    title: "Quick compat issue",
    prompt: "do the thing",
    workspace_id: refs.workspaceId,
    agent_id: refs.agentId,
  });
  await rec.json("POST", "/api/issues/batch-update", { issue_ids: [id], status: "done" });
  await rec.json("POST", `/api/issues/${id}/squad-evaluated`, { outcome: "no_action", reason: "nothing to do" });
  await rec.json("POST", "/api/issues/batch-delete", { issue_ids: [id] });
  await rec.call("DELETE", `/api/issues/${refs.childIssueId}`);
});

flow("issues-native", async (rec, refs) => {
  const created = await rec.json("POST", "/api/multiremi/issues", {
    title: "Native issue",
    workspaceId: refs.workspaceId,
    projectId: refs.projectId,
  });
  const id = created.body?.id ?? refs.issueId;
  await rec.json("PATCH", `/api/multiremi/issues/${id}`, { status: "in_progress" });
  await rec.json("POST", `/api/multiremi/issues/${id}/assign`, { assigneeType: "agent", assigneeId: refs.agentId });
  await rec.json("POST", "/api/multiremi/issues/quick-create", {
    title: "Quick native issue",
    prompt: "do the thing",
    workspaceId: refs.workspaceId,
    agentId: refs.agentId,
  });
  await rec.json("POST", "/api/multiremi/issues/batch-update", { issueIds: [id], status: "done" });
  await rec.json("POST", "/api/multiremi/issues/batch-delete", { issueIds: [id] });
  await rec.call("DELETE", `/api/multiremi/issues/${refs.childIssueId}`);
});

flow("issue-shares", async (rec, refs) => {
  await rec.call("POST", `/api/issues/${refs.issueId}/share`);
  await rec.call("POST", `/api/issues/${refs.issueId}/share/extend`);
  await rec.call("DELETE", `/api/issues/${refs.issueId}/share`);
});

flow("issue-relations-compat", async (rec, refs) => {
  await rec.json("POST", `/api/issues/${refs.issueId}/labels`, { label_id: refs.labelId });
  await rec.call("DELETE", `/api/issues/${refs.issueId}/labels/${refs.labelId}`);
  await rec.json("PUT", `/api/issues/${refs.issueId}/metadata/branch`, { value: "feat/snapshot" });
  await rec.call("DELETE", `/api/issues/${refs.issueId}/metadata/branch`);
  await rec.json("POST", `/api/issues/${refs.issueId}/reactions`, { emoji: "rocket" });
  await rec.json("DELETE", `/api/issues/${refs.issueId}/reactions`, { emoji: "rocket" });
  await rec.json("POST", `/api/issues/${refs.issueId}/subscribe`, { member_id: refs.otherMemberId });
  await rec.json("POST", `/api/issues/${refs.issueId}/unsubscribe`, { member_id: refs.otherMemberId });
  const dependency = await rec.json("POST", `/api/issues/${refs.issueId}/dependencies`, {
    depends_on_issue_id: refs.blockedIssueId,
    type: "blocks",
  });
  const dependencyId = dependency.body?.id ?? refs.dependencyId;
  await rec.call("DELETE", `/api/issues/${refs.issueId}/dependencies/${dependencyId}`);
});

flow("issue-relations-native", async (rec, refs) => {
  await rec.json("POST", `/api/multiremi/issues/${refs.issueId}/labels`, { labelId: refs.labelId });
  await rec.call("DELETE", `/api/multiremi/issues/${refs.issueId}/labels/${refs.labelId}`);
  await rec.json("PUT", `/api/multiremi/issues/${refs.issueId}/metadata/branch`, { value: "feat/native" });
  await rec.call("DELETE", `/api/multiremi/issues/${refs.issueId}/metadata/branch`);
  await rec.json("POST", `/api/multiremi/issues/${refs.issueId}/reactions`, { emoji: "rocket" });
  await rec.json("DELETE", `/api/multiremi/issues/${refs.issueId}/reactions`, { emoji: "rocket" });
  await rec.json("POST", `/api/multiremi/issues/${refs.issueId}/subscribers`, { memberId: refs.otherMemberId, reason: "manual" });
  await rec.call("DELETE", `/api/multiremi/issues/${refs.issueId}/subscribers/${refs.otherMemberId}`);
  const dependency = await rec.json("POST", `/api/multiremi/issues/${refs.issueId}/dependencies`, {
    dependsOnIssueId: refs.blockedIssueId,
    type: "blocks",
  });
  const dependencyId = dependency.body?.id ?? refs.dependencyId;
  await rec.call("DELETE", `/api/multiremi/issues/${refs.issueId}/dependencies/${dependencyId}`);
});

// -- comments ---------------------------------------------------------------
flow("comments-compat", async (rec, refs) => {
  const created = await rec.json("POST", `/api/issues/${refs.issueId}/comments`, {
    body: "Compat comment",
    author_type: "member",
    author_id: refs.memberId,
  });
  const id = created.body?.id ?? refs.commentId;
  await rec.json("PUT", `/api/comments/${id}`, { body: "Compat comment edited" });
  await rec.json("POST", `/api/comments/${id}/reactions`, { emoji: "tada" });
  await rec.json("DELETE", `/api/comments/${id}/reactions`, { emoji: "tada" });
  await rec.json("POST", `/api/comments/${id}/resolve`, {});
  await rec.call("DELETE", `/api/comments/${id}/resolve`);
  await rec.call("DELETE", `/api/comments/${id}`);
});

flow("comments-native", async (rec, refs) => {
  const created = await rec.json("POST", `/api/multiremi/issues/${refs.issueId}/comments`, {
    body: "Native comment",
    authorType: "member",
    authorId: refs.memberId,
  });
  const id = created.body?.id ?? refs.commentId;
  await rec.json("PATCH", `/api/multiremi/comments/${id}`, { body: "Native comment patched" });
  await rec.json("PUT", `/api/multiremi/comments/${id}`, { body: "Native comment put" });
  await rec.json("POST", `/api/multiremi/comments/${id}/reactions`, { emoji: "tada" });
  await rec.json("DELETE", `/api/multiremi/comments/${id}/reactions`, { emoji: "tada" });
  await rec.json("POST", `/api/multiremi/comments/${id}/resolve`, {});
  await rec.call("DELETE", `/api/multiremi/comments/${id}/resolve`);
  await rec.call("DELETE", `/api/multiremi/comments/${id}`);
});

// -- labels -----------------------------------------------------------------
flow("labels", async (rec, refs) => {
  const compat = await rec.json("POST", "/api/labels", { name: "compat-label", color: "#ff0000", workspace_id: refs.workspaceId });
  const compatId = compat.body?.id ?? refs.labelId;
  await rec.json("PUT", `/api/labels/${compatId}`, { name: "compat-label-renamed", color: "#00ff00" });
  await rec.call("DELETE", `/api/labels/${compatId}`);
  const native = await rec.json("POST", "/api/multiremi/labels", { name: "native-label", color: "#0000ff", workspaceId: refs.workspaceId });
  const nativeId = native.body?.id ?? refs.labelId;
  await rec.json("PATCH", `/api/multiremi/labels/${nativeId}`, { name: "native-label-patched" });
  await rec.json("PUT", `/api/multiremi/labels/${nativeId}`, { color: "#123456" });
  await rec.call("DELETE", `/api/multiremi/labels/${nativeId}`);
});

// -- projects ---------------------------------------------------------------
flow("projects", async (rec, refs) => {
  const compat = await rec.json("POST", "/api/projects", { title: "Compat project", description: "compat" });
  const compatId = compat.body?.id ?? refs.projectId;
  await rec.json("PUT", `/api/projects/${compatId}`, { title: "Compat project renamed" });
  const resource = await rec.json("POST", `/api/projects/${compatId}/resources`, {
    resource_type: "github_repo",
    resource_ref: { url: "https://example.invalid/compat.git" },
  });
  const resourceId = resource.body?.id ?? refs.projectResourceId;
  await rec.json("PUT", `/api/projects/${compatId}/resources/${resourceId}`, { label: "renamed" });
  await rec.call("DELETE", `/api/projects/${compatId}/resources/${resourceId}`);
  await rec.call("DELETE", `/api/projects/${compatId}`);

  const native = await rec.json("POST", "/api/multiremi/projects", { title: "Native project" });
  const nativeId = native.body?.id ?? refs.projectId;
  await rec.json("PATCH", `/api/multiremi/projects/${nativeId}`, { title: "Native project patched" });
  const nativeResource = await rec.json("POST", `/api/multiremi/projects/${nativeId}/resources`, {
    resourceType: "github_repo",
    resourceRef: { url: "https://example.invalid/native.git" },
  });
  const nativeResourceId = nativeResource.body?.id ?? refs.projectResourceId;
  await rec.json("PATCH", `/api/multiremi/projects/${nativeId}/resources/${nativeResourceId}`, { label: "native renamed" });
  await rec.call("DELETE", `/api/multiremi/projects/${nativeId}/resources/${nativeResourceId}`);
  await rec.call("DELETE", `/api/multiremi/projects/${nativeId}`);
});

flow("project-docs", async (rec, refs) => {
  const created = await rec.json("POST", `/api/projects/${refs.projectId}/docs`, {
    kind: "wiki",
    slug: "runbook",
    title: "Runbook",
    body: "# runbook",
  });
  const ref = created.body?.slug ?? created.body?.doc?.slug ?? "runbook";
  await rec.json("PUT", `/api/projects/${refs.projectId}/docs/${ref}`, { title: "Runbook v2", body: "# runbook v2" });
  await rec.call("DELETE", `/api/projects/${refs.projectId}/docs/${ref}`);
});

// -- squads -----------------------------------------------------------------
flow("squads", async (rec, refs) => {
  const compat = await rec.json("POST", "/api/squads", {
    name: "Compat squad",
    workspace_id: refs.workspaceId,
    leader_id: refs.agentId,
  });
  const compatId = compat.body?.id ?? refs.squadId;
  await rec.json("PUT", `/api/squads/${compatId}`, { name: "Compat squad renamed" });
  await rec.json("POST", `/api/squads/${compatId}/members`, { member_type: "agent", member_id: refs.agentId });
  await rec.json("PATCH", `/api/squads/${compatId}/members/role`, {
    member_type: "agent",
    member_id: refs.agentId,
    role: "leader",
  });
  await rec.json("DELETE", `/api/squads/${compatId}/members`, { member_type: "agent", member_id: refs.agentId });
  await rec.call("DELETE", `/api/squads/${compatId}`);

  const native = await rec.json("POST", "/api/multiremi/squads", { name: "Native squad", workspaceId: refs.workspaceId });
  const nativeId = native.body?.id ?? refs.squadId;
  await rec.json("PATCH", `/api/multiremi/squads/${nativeId}`, { name: "Native squad patched" });
  await rec.json("POST", `/api/multiremi/squads/${nativeId}/members`, { memberType: "agent", memberId: refs.agentId });
  await rec.json("PATCH", `/api/multiremi/squads/${nativeId}/members`, {
    memberType: "agent",
    memberId: refs.agentId,
    role: "leader",
  });
  await rec.json("DELETE", `/api/multiremi/squads/${nativeId}/members`, { memberType: "agent", memberId: refs.agentId });
  await rec.call("DELETE", `/api/multiremi/squads/${nativeId}`);
});

// -- autopilots -------------------------------------------------------------
flow("autopilots-compat", async (rec, refs) => {
  const created = await rec.json("POST", "/api/autopilots", {
    title: "Compat autopilot",
    assignee_type: "agent",
    assignee_id: refs.agentId,
    workspace_id: refs.workspaceId,
    execution_mode: "create_issue",
  });
  const id = created.body?.id ?? refs.autopilotId;
  await rec.json("PATCH", `/api/autopilots/${id}`, { title: "Compat autopilot patched" });
  const trigger = await rec.json("POST", `/api/autopilots/${id}/triggers`, { kind: "webhook", provider: "github" });
  const triggerId = trigger.body?.id ?? refs.triggerId;
  await rec.json("PATCH", `/api/autopilots/${id}/triggers/${triggerId}`, { enabled: false });
  await rec.json("PUT", `/api/autopilots/${id}/triggers/${triggerId}/signing-secret`, { secret: "snapshot-secret" });
  await rec.json("POST", `/api/autopilots/${id}/triggers/${triggerId}/rotate-webhook-token`, {});
  await rec.json("POST", `/api/autopilots/${id}/trigger`, { prompt: "run it" });
  await rec.json("PATCH", `/api/autopilots/${id}`, { status: "paused" });
  await rec.json("POST", `/api/autopilots/${refs.autopilotId}/deliveries/${refs.deliveryId}/replay`, {});
  await rec.call("DELETE", `/api/autopilots/${id}/triggers/${triggerId}`);
  await rec.call("DELETE", `/api/autopilots/${id}`);
});

flow("autopilots-native", async (rec, refs) => {
  const created = await rec.json("POST", "/api/multiremi/autopilots", {
    title: "Native autopilot",
    assigneeType: "agent",
    assigneeId: refs.agentId,
    workspaceId: refs.workspaceId,
  });
  const id = created.body?.id ?? refs.autopilotId;
  await rec.json("PATCH", `/api/multiremi/autopilots/${id}`, { title: "Native autopilot patched" });
  await rec.json("POST", `/api/multiremi/autopilots/${id}/run`, { source: "manual", prompt: "native run" });
  await rec.json("POST", `/api/multiremi/autopilots/${id}/run-scheduled`, {});
  await rec.json("POST", `/api/multiremi/autopilots/${id}/trigger`, { prompt: "native trigger" });
  await rec.json("POST", `/api/multiremi/autopilots/${id}/webhook`, { action: "opened" });
  await rec.json("POST", `/api/multiremi/autopilots/${refs.autopilotId}/deliveries/${refs.deliveryId}/replay`, {});
  await rec.call("DELETE", `/api/multiremi/autopilots/${id}`);
});

flow("webhooks", async (rec, refs) => {
  await rec.json("POST", `/api/webhooks/autopilots/${refs.webhookToken}`, { action: "opened" });
  await rec.json("POST", "/api/webhooks/stripe", { type: "checkout.session.completed" });
});

// -- runtimes ---------------------------------------------------------------
flow("runtimes", async (rec, refs) => {
  const created = await rec.json("POST", "/api/multiremi/runtimes", {
    name: "flow-runtime",
    provider: "codex",
    workspaceId: refs.workspaceId,
  });
  const id = created.body?.id ?? refs.runtimeId;
  await rec.json("PATCH", `/api/multiremi/runtimes/${id}`, { name: "flow-runtime-native" });
  await rec.json("PATCH", `/api/runtimes/${id}`, { name: "flow-runtime-compat", max_concurrency: 4 });
  await rec.json("POST", `/api/multiremi/runtimes/${id}/heartbeat`, {});
  await rec.json("PUT", `/api/multiremi/runtimes/${id}/models`, { models: [{ id: "gpt-5", name: "GPT-5" }] });
  await rec.json("PUT", `/api/runtimes/${id}/models`, { models: [{ id: "gpt-5-mini", name: "GPT-5 mini" }] });
  await rec.json("POST", `/api/multiremi/runtimes/${id}/models`, {});
  await rec.json("POST", `/api/runtimes/${id}/models`, {});
  await rec.json("POST", `/api/multiremi/runtimes/${id}/directory-scans`, { root: "/snapshot", mode: "scan" });
  await rec.json("POST", `/api/runtimes/${id}/directory-scans`, { root: "/snapshot", mode: "browse" });
  await rec.json("POST", `/api/multiremi/runtimes/${id}/local-skills`, {});
  await rec.json("POST", `/api/runtimes/${id}/local-skills`, {});
  await rec.json("POST", `/api/multiremi/runtimes/${id}/local-skills/import`, { skillKey: "snapshot-skill" });
  await rec.json("POST", `/api/runtimes/${id}/local-skills/import`, { skill_key: "snapshot-skill" });
  await rec.json("POST", `/api/multiremi/runtimes/${id}/update`, { targetVersion: "9.9.9" });
  await rec.json("POST", `/api/runtimes/${id}/update`, { target_version: "9.9.9" });
  const command = await rec.json("POST", `/api/runtimes/${id}/commands`, {
    command: "printf snapshot",
    timeout_ms: 1_000,
  });
  await rec.call("GET", `/api/runtimes/${id}/commands/${command.body?.id ?? refs.runtimeCommandRequestId}`);
  await rec.json("POST", `/api/runtimes/${id}/archive-agents-and-delete`, {});
  await rec.call("DELETE", `/api/runtimes/${refs.runtimeId}`);
});

flow("daemon-retirement", async (rec, refs) => {
  const plan = await rec.call(
    "GET",
    `/api/multiremi/daemons/dmn_snapshot/retirement-plan?workspace_id=${encodeURIComponent(refs.workspaceId)}`,
  );
  await rec.json("POST", "/api/multiremi/daemons/dmn_snapshot/retire", {
    workspace_id: refs.workspaceId,
    expected_snapshot: plan.body?.plan?.snapshot,
  });
});

// -- daemon -----------------------------------------------------------------
flow("daemon", async (rec, refs) => {
  await rec.json("POST", "/api/daemon/register", {
    workspace_id: refs.workspaceId,
    daemon_id: "dmn_flow",
    device_name: "flow-device",
    cli_version: "9.9.9",
    runtimes: [{ name: "flow-runtime", type: "claude", version: "9.9.9", status: "online", maxConcurrency: 1 }],
  });
  await rec.json("POST", "/api/daemon/heartbeat", { runtime_id: refs.runtimeId });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/tasks/claim`, {});
  await rec.json("PUT", `/api/daemon/runtimes/${refs.runtimeId}/models`, {
    models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4" }],
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/models/claim`, {});
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/models/${refs.runtimeModelRequestId}/result`, {
    models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/directory-scans/claim`, {});
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/directory-scans/${refs.dirScanRequestId}/result`, {
    entries: [{ path: "/snapshot/project", name: "project", is_git_repo: true }],
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/local-skills/claim`, {});
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/local-skills/${refs.localSkillListRequestId}/result`, {
    skills: [{ key: "snapshot-skill", name: "Snapshot skill" }],
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/local-skills/import/claim`, {});
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/local-skills/import/${refs.localSkillImportRequestId}/result`, {
    files: [{ path: "SKILL.md", content: "# imported" }],
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/update/claim`, {});
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/update/${refs.runtimeUpdateRequestId}/result`, {
    status: "completed",
    version: "9.9.9",
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/commands/claim`, {});
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/commands/${refs.runtimeCommandRequestId}/result`, {
    status: "completed",
    exit_code: 0,
    stdout: "snapshot",
    stderr: "",
    duration_ms: 1,
  });
  await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/recover-orphans`, {});
  await rec.json("POST", "/api/daemon/deregister", { runtime_ids: [refs.runtimeId] });
});

flow("daemon-task-lifecycle", async (rec, refs) => {
  const task = await rec.json("POST", "/api/multiremi/tasks", {
    agentId: refs.agentId,
    issueId: refs.issueId,
    prompt: "Snapshot lifecycle task",
  });
  const id = task.body?.id ?? task.body?.task?.id ?? refs.taskId;
  // The seeded chat session has its own queued task, so claim until ours lands.
  for (let attempt = 0; attempt < 6; attempt++) {
    const claim = await rec.json("POST", `/api/daemon/runtimes/${refs.runtimeId}/tasks/claim`, {});
    if ((claim.body?.task?.id ?? claim.body?.id) === id) break;
  }
  // waiting_local_directory only applies to a dispatched task, so it runs
  // before start (startTask accepts dispatched and waiting_local_directory).
  await rec.json("POST", `/api/daemon/tasks/${id}/wait-local-directory`, { reason: "missing repo" });
  await rec.json("POST", `/api/daemon/tasks/${id}/start`, {});
  await rec.json("POST", `/api/daemon/tasks/${id}/progress`, { summary: "half", step: 1, total: 2 });
  await rec.json("POST", `/api/daemon/tasks/${id}/messages`, { messages: [{ type: "assistant", content: "hello" }] });
  const assembledPrompt = "# Bootstrap Prompt\n\n## Current Request\nSnapshot lifecycle task";
  await rec.json("POST", `/api/daemon/tasks/${id}/prompt`, {
    mode: "bootstrap",
    prompt: assembledPrompt,
    sha256: createHash("sha256").update(assembledPrompt).digest("hex"),
  });
  await rec.call("GET", `/api/tasks/${id}/prompt`);
  await rec.json("POST", `/api/daemon/tasks/${id}/session`, { session_id: "ses_snapshot", work_dir: "/snapshot/work" });
  await rec.json("POST", `/api/daemon/tasks/${id}/usage`, { usage: [{ model: "claude-sonnet-4", input_tokens: 3, output_tokens: 4 }] });
  const human = await rec.json("POST", `/api/daemon/tasks/${id}/human-requests`, {
    kind: "permission",
    payload: { tool: "Bash" },
  });
  const requestId = human.body?.id ?? human.body?.request_id ?? human.body?.request?.id ?? refs.humanRequestId;
  await rec.json("POST", `/api/multiremi/tasks/${id}/human-requests/${requestId}/respond`, { outcome: "approved" });
  const second = await rec.json("POST", `/api/daemon/tasks/${id}/human-requests`, {
    kind: "permission",
    payload: { tool: "Read" },
  });
  const secondId = second.body?.id ?? second.body?.request_id ?? second.body?.request?.id ?? requestId;
  await rec.json("POST", `/api/tasks/${id}/human-requests/${secondId}/respond`, { outcome: "approved" });
  const third = await rec.json("POST", `/api/daemon/tasks/${id}/human-requests`, {
    kind: "permission",
    payload: { tool: "Write" },
  });
  const thirdId = third.body?.id ?? third.body?.request_id ?? third.body?.request?.id ?? secondId;
  await rec.json("POST", `/api/daemon/tasks/${id}/human-requests/${thirdId}/expire`, { status: "timeout" });
  await rec.json("POST", `/api/daemon/tasks/${id}/complete`, { result: "done", summary: "complete" });
  await rec.json("POST", `/api/daemon/tasks/${refs.taskId}/fail`, { error: "boom" });
});

flow("tasks", async (rec, refs) => {
  const task = await rec.json("POST", "/api/multiremi/tasks", { agentId: refs.agentId, prompt: "Cancellable task" });
  const id = task.body?.id ?? task.body?.task?.id ?? refs.taskId;
  await rec.json("POST", `/api/multiremi/tasks/${id}/cancel`, {});
  const compat = await rec.json("POST", "/api/multiremi/tasks", { agentId: refs.agentId, prompt: "Compat cancel task" });
  const compatId = compat.body?.id ?? compat.body?.task?.id ?? refs.taskId;
  await rec.json("POST", `/api/tasks/${compatId}/cancel`, {});
  const scoped = await rec.json("POST", "/api/multiremi/tasks", {
    agentId: refs.agentId,
    issueId: refs.issueId,
    prompt: "Issue scoped cancel task",
  });
  const scopedId = scoped.body?.id ?? scoped.body?.task?.id ?? refs.taskId;
  await rec.json("POST", `/api/issues/${refs.issueId}/tasks/${scopedId}/cancel`, {});
  await rec.json("POST", `/api/issues/${refs.issueId}/rerun`, {});
});

// -- issue sessions ---------------------------------------------------------
flow("issue-sessions", async (rec, refs) => {
  const created = await rec.json("POST", `/api/issues/${refs.issueId}/sessions`, { title: "Flow session" });
  const id = created.body?.id ?? refs.issueSessionId;
  await rec.json("PATCH", `/api/issues/${refs.issueId}/sessions/${id}`, { title: "Flow session renamed", status: "active" });
  await rec.json("POST", `/api/issues/${refs.issueId}/sessions/${id}/participants`, {
    participant_type: "agent",
    participant_id: refs.agentId,
  });
  await rec.json("POST", `/api/issues/${refs.issueId}/sessions/${id}/messages`, { body: "session message" });
  await rec.json("POST", `/api/issues/${refs.issueId}/sessions/${id}/results`, { title: "result", body: "session result" });
  await rec.json("POST", `/api/issues/${refs.issueId}/sessions/${id}/tasks`, { agent_id: refs.agentId, prompt: "session task" });
  await rec.call("DELETE", `/api/issues/${refs.issueId}/sessions/${id}/participants/agent/${refs.agentId}`);
});

// -- chat -------------------------------------------------------------------
flow("chat", async (rec, refs) => {
  const compat = await rec.json("POST", "/api/chat/sessions", { agent_id: refs.agentId, title: "Compat chat" });
  const compatId = compat.body?.id ?? refs.chatSessionId;
  await rec.json("POST", `/api/chat/sessions/${compatId}/messages`, { body: "compat message" });
  await rec.json("POST", `/api/chat/sessions/${compatId}/read`, {});
  await rec.json("PATCH", `/api/chat/sessions/${compatId}`, { title: "Compat chat renamed" });
  await rec.call("DELETE", `/api/chat/sessions/${compatId}`);

  const native = await rec.json("POST", "/api/multiremi/chats", { agentId: refs.agentId, title: "Native chat" });
  const nativeId = native.body?.id ?? refs.chatSessionId;
  await rec.json("POST", `/api/multiremi/chats/${nativeId}/messages`, { body: "native message" });
  await rec.json("PATCH", `/api/multiremi/chats/${nativeId}`, { title: "Native chat renamed" });
});

// -- inbox ------------------------------------------------------------------
flow("inbox", async (rec, refs) => {
  await rec.json("POST", `/api/inbox/${refs.inboxItemId}/read`, {});
  await rec.json("POST", `/api/inbox/${refs.inboxItemId}/archive`, {});
  await rec.json("POST", `/api/multiremi/inbox/${refs.inboxItemId}/read`, {});
  await rec.json("POST", `/api/multiremi/inbox/${refs.inboxItemId}/archive`, {});
  const member = `?member_id=${encodeURIComponent(refs.inboxMemberId)}`;
  await rec.json("POST", `/api/inbox/mark-all-read${member}`, {});
  await rec.json("POST", `/api/inbox/archive-all-read${member}`, {});
  await rec.json("POST", `/api/inbox/archive-completed${member}`, {});
  await rec.json("POST", `/api/inbox/archive-all${member}`, {});
});

// -- pins -------------------------------------------------------------------
flow("pins", async (rec, refs) => {
  const compat = await rec.json("POST", "/api/pins", { item_type: "issue", item_id: refs.issueId });
  await rec.json("PUT", "/api/pins/reorder", { items: [{ id: compat.body?.id ?? "pin_snapshot", position: 1 }] });
  await rec.call("DELETE", `/api/pins/issue/${refs.issueId}`);
  const native = await rec.json("POST", "/api/multiremi/pins", { itemType: "project", itemId: refs.projectId });
  await rec.json("PUT", "/api/multiremi/pins/reorder", { items: [{ id: native.body?.id ?? "pin_snapshot", position: 1 }] });
  await rec.call("DELETE", `/api/multiremi/pins/project/${refs.projectId}`);
});

// -- tokens -----------------------------------------------------------------
flow("tokens", async (rec, refs) => {
  const compat = await rec.json("POST", "/api/tokens", { name: "compat token", type: "pat" });
  await rec.json("POST", "/api/tokens/current/renew", {});
  await rec.call("DELETE", `/api/tokens/${compat.body?.id ?? refs.tokenId}`);
  const native = await rec.json("POST", "/api/multiremi/tokens", { name: "native token", type: "pat" });
  await rec.call("DELETE", `/api/multiremi/tokens/${native.body?.id ?? refs.tokenId}`);
  await rec.json("POST", "/api/cli-token", {});
});

// -- workspaces / members / invitations -------------------------------------
flow("workspaces", async (rec, refs) => {
  const created = await rec.json("POST", "/api/workspaces", { name: "Flow workspace", slug: "flow-workspace" });
  const id = created.body?.id ?? refs.otherWorkspaceId;
  await rec.json("PUT", `/api/workspaces/${id}`, { name: "Flow workspace renamed" });
  await rec.json("PATCH", `/api/workspaces/${id}`, { description: "patched" });
  const invited = await rec.json("POST", `/api/workspaces/${id}/members`, { email: "invitee@snapshot.invalid", role: "member" });
  const invitationId = invited.body?.id ?? invited.body?.invitation?.id ?? refs.invitationId;
  await rec.json("PATCH", `/api/workspaces/${refs.workspaceId}/members/${refs.otherMemberId}`, { role: "admin" });
  await rec.call("DELETE", `/api/workspaces/${refs.workspaceId}/members/${refs.otherMemberId}`);
  await rec.call("DELETE", `/api/workspaces/${id}/invitations/${invitationId}`);
  await rec.json("PUT", `/api/workspaces/${id}/relay-config/claude`, { baseUrl: "https://relay.invalid", token: "relay-token" });
  await rec.json("POST", `/api/workspaces/${id}/relay-config/claude/reveal`, {});
  await rec.json("PUT", `/api/workspaces/${id}/relay-config/discovery`, { enabled: true });
  await rec.json("POST", `/api/workspaces/${id}/lark/install/begin`, {});
  await rec.call("DELETE", `/api/workspaces/${id}/lark/installations/inst_snapshot`);
  await rec.json("POST", `/api/workspaces/${id}/leave`, {});
  await rec.call("DELETE", `/api/workspaces/${id}`);
});

flow("members-invitations", async (rec, refs) => {
  const created = await rec.json("POST", "/api/multiremi/members", {
    name: "Native member",
    email: "native@snapshot.invalid",
    workspaceId: refs.workspaceId,
    role: "member",
  });
  const id = created.body?.id ?? refs.otherMemberId;
  await rec.json("PATCH", `/api/multiremi/members/${id}`, { role: "admin" });
  await rec.call("DELETE", `/api/multiremi/members/${id}`);
  await rec.json("POST", `/api/invitations/${refs.invitationId}/decline`, {});
  await rec.json("POST", `/api/invitations/${refs.invitationId}/accept`, {});
});

// -- me / onboarding / auth -------------------------------------------------
flow("me", async (rec, refs) => {
  await rec.json("PATCH", "/api/me", { name: "Snapshot User", language: "en" });
  await rec.json("PATCH", "/api/me/onboarding", { role: "engineer" });
  await rec.json("POST", "/api/me/onboarding/complete", {});
  await rec.json("POST", "/api/me/onboarding/cloud-waitlist", { email: "waitlist@snapshot.invalid" });
  await rec.json("POST", "/api/me/onboarding/runtime-bootstrap", { workspace_id: "local", runtime_id: refs.runtimeId });
  await rec.json("POST", "/api/me/onboarding/no-runtime-bootstrap", { workspace_id: "local" });
});

flow("auth", async (rec) => {
  await rec.json("POST", "/auth/send-code", { email: "user@snapshot.invalid" });
  await rec.json("POST", "/auth/verify-code", { email: "user@snapshot.invalid", code: "424242" });
  await rec.json("POST", "/auth/google", { credential: "snapshot-credential" });
  await rec.json("POST", "/auth/lark/callback", { code: "snapshot-code", redirect_uri: "https://snapshot.invalid/callback" });
  await rec.json("POST", "/auth/logout", {});
  await rec.json("POST", "/api/lark/binding/redeem", { code: "snapshot-binding" });
});

// -- attachments ------------------------------------------------------------
flow("attachments", async (rec, refs) => {
  const form = new FormData();
  form.append("file", new File(["snapshot file body"], "snapshot.txt", { type: "text/plain" }));
  await rec.call("POST", "/api/upload-file", { body: form });
  const created = await rec.json("POST", "/api/multiremi/attachments", {
    filename: "native.txt",
    url: "/api/attachments/native/content",
    contentType: "text/plain",
    sizeBytes: 4,
    issueId: refs.issueId,
  });
  await rec.json("POST", `/api/multiremi/issues/${refs.issueId}/attachments`, {
    filename: "linked.txt",
    url: "/api/attachments/linked/content",
    contentType: "text/plain",
    sizeBytes: 5,
  });
  const attachmentId = created.body?.id ?? created.body?.attachment?.id ?? refs.attachmentId;
  await rec.call("DELETE", `/api/attachments/${attachmentId}`);
});

// -- settings / misc --------------------------------------------------------
flow("settings-misc", async (rec, refs) => {
  await rec.json("PUT", "/api/notification-preferences", { email_enabled: false });
  await rec.json("PUT", "/api/multiremi/notification-preferences", { emailEnabled: true });
  await rec.json("POST", "/api/feedback", { message: "Compat feedback" });
  await rec.json("POST", "/api/multiremi/feedback", { message: "Native feedback" });
  await rec.json("POST", "/api/contact-sales", { email: "sales@snapshot.invalid", message: "hi" });
  await rec.json("POST", "/api/multiremi/install/daemon", { provider: "claude" });
});

flow("cloud", async (rec) => {
  const node = await rec.json("POST", "/api/cloud-runtime/nodes", { instance_type: "small", name: "snapshot-node" });
  const nodeId = node.body?.id ?? node.body?.node?.id ?? "node_snapshot";
  await rec.json("POST", "/api/cloud-runtime/nodes/status", { id: nodeId });
  await rec.json("POST", "/api/cloud-runtime/nodes/start", { id: nodeId });
  await rec.json("POST", "/api/cloud-runtime/nodes/stop", { id: nodeId });
  await rec.json("POST", "/api/cloud-runtime/nodes/reboot", { id: nodeId });
  await rec.json("POST", "/api/cloud-runtime/nodes/exec", { id: nodeId, command: "uname -a" });
  await rec.json("DELETE", "/api/cloud-runtime/nodes", { id: nodeId });
  await rec.json("POST", "/api/cloud-billing/checkout-sessions", { tier: "starter" });
  await rec.json("POST", "/api/cloud-billing/portal-sessions", {});
});

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

export interface SnapshotFile {
  meta: {
    harness: string;
    routeCount: number;
    routeCountByPrefix: Record<string, number>;
    getRoutes: number;
    getRoutesWithBody: number;
    statusOnlyRoutes: string[];
    mutationRoutes: number;
    mutationRoutesCovered: number;
    flows: string[];
    normalizer: string[];
  };
  routes: string[];
  coveredRoutes: string[];
  entries: SnapshotEntry[];
}

export async function captureApiSnapshot(): Promise<SnapshotFile> {
  const restore = installDeterminism();
  try {
    // --- route inventory (mechanically enumerated from the Hono route table)
    resetDeterministicState();
    const inventoryBoot = await buildApp();
    const routes = routeTable(inventoryBoot.app);
    inventoryBoot.db.close();

    const routeKeys = routes.map((route) => `${route.method} ${route.path}`);
    const byPrefix: Record<string, number> = { native: 0, compat: 0, root: 0 };
    for (const route of routes) {
      if (route.path.startsWith("/api/multiremi/")) byPrefix.native += 1;
      else if (route.path.startsWith("/api/")) byPrefix.compat += 1;
      else byPrefix.root += 1;
    }

    const entries: SnapshotEntry[] = [];
    const covered = new Set<string>();

    // --- GET sweep: every registered GET route, one shared seeded app -------
    resetDeterministicState();
    const sweep = await buildApp();
    const sweepRefs = sweep.refs;
    const templates = await sweep.app.request("/api/agent-templates");
    const templateList = (await templates.json()) as Array<{ slug?: string }>;
    sweepRefs.templateSlug = templateList?.[0]?.slug ?? "unknown-template";
    const sweepRecorder = new Recorder(sweep.app, routes, "get-sweep");
    for (const route of routes) {
      if (route.method !== "GET") continue;
      const key = `${route.method} ${route.path}`;
      if (STATUS_ONLY_ROUTES.has(key)) {
        covered.add(key);
        let status: number | string = "unavailable";
        try {
          status = (await sweep.app.request(concretePath(route.path, sweepRefs))).status;
        } catch (error) {
          status = `threw: ${(error as Error).name}`;
        }
        entries.push({
          key: `get-sweep ${key}`,
          route: key,
          path: route.path,
          status,
          body: { __body__: { omitted: "websocket-upgrade route; status recorded only" } },
        });
        continue;
      }
      await sweepRecorder.call("GET", concretePath(route.path, sweepRefs));
      covered.add(key);
    }
    // Keys inside the sweep must not depend on request order.
    for (const entry of sweepRecorder.entries) {
      entries.push({ ...entry, key: `get-sweep ${entry.route}` });
    }
    sweep.db.close();

    // --- mutation flows: fresh seeded store per family ---------------------
    for (const { name, run } of [...MUTATION_FLOWS].sort((a, b) => a.name.localeCompare(b.name))) {
      resetDeterministicState();
      const boot = await buildApp();
      const recorder = new Recorder(boot.app, routes, name);
      await run(recorder, boot.refs);
      for (const entry of recorder.entries) entries.push(entry);
      for (const route of recorder.covered) covered.add(route);
      boot.db.close();
    }

    entries.sort((left, right) => left.key.localeCompare(right.key));

    const mutationRoutes = routeKeys.filter((key) => !key.startsWith("GET "));
    const mutationCovered = mutationRoutes.filter((key) => covered.has(key));
    const getRoutes = routeKeys.filter((key) => key.startsWith("GET "));

    return {
      meta: {
        harness: "scripts/snapshot-api-routes.ts",
        routeCount: routes.length,
        routeCountByPrefix: byPrefix,
        getRoutes: getRoutes.length,
        getRoutesWithBody: getRoutes.length - STATUS_ONLY_ROUTES.size,
        statusOnlyRoutes: [...STATUS_ONLY_ROUTES].sort(),
        mutationRoutes: mutationRoutes.length,
        mutationRoutesCovered: mutationCovered.length,
        flows: MUTATION_FLOWS.map((item) => item.name).sort(),
        normalizer: NORMALIZER_RULES,
      },
      routes: routeKeys,
      coveredRoutes: [...covered].sort(),
      entries,
    };
  } finally {
    restore();
  }
}

export function serializeSnapshot(snapshot: SnapshotFile): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const twice = args.includes("--twice");
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : GOLDEN_PATH;

  const first = serializeSnapshot(await captureApiSnapshot());

  if (twice) {
    const second = serializeSnapshot(await captureApiSnapshot());
    if (first !== second) {
      const firstLines = first.split("\n");
      const secondLines = second.split("\n");
      const diff: string[] = [];
      for (let i = 0; i < Math.max(firstLines.length, secondLines.length) && diff.length < 20; i++) {
        if (firstLines[i] !== secondLines[i]) diff.push(`line ${i + 1}:\n  run1: ${firstLines[i]}\n  run2: ${secondLines[i]}`);
      }
      console.error(`NON-DETERMINISTIC: two runs differ (${first.length} vs ${second.length} bytes)`);
      console.error(diff.join("\n"));
      process.exit(1);
    }
    console.log(`deterministic: two runs are byte-identical (${first.length} bytes)`);
  }

  if (check) {
    if (!existsSync(outPath)) {
      console.error(`missing golden file: ${outPath}`);
      process.exit(1);
    }
    const golden = readFileSync(outPath, "utf8");
    if (golden !== first) {
      const goldenLines = golden.split("\n");
      const currentLines = first.split("\n");
      const diff: string[] = [];
      for (let i = 0; i < Math.max(goldenLines.length, currentLines.length) && diff.length < 40; i++) {
        if (goldenLines[i] !== currentLines[i]) diff.push(`line ${i + 1}:\n  golden:  ${goldenLines[i]}\n  current: ${currentLines[i]}`);
      }
      console.error(`SNAPSHOT DIFF against ${outPath}`);
      console.error(diff.join("\n"));
      process.exit(1);
    }
    console.log(`snapshot matches ${outPath}`);
    return;
  }

  writeFileSync(outPath, first);
  const snapshot = JSON.parse(first) as SnapshotFile;
  console.log(`wrote ${outPath}`);
  console.log(
    `routes=${snapshot.meta.routeCount} (native=${snapshot.meta.routeCountByPrefix.native}, compat=${snapshot.meta.routeCountByPrefix.compat}, root=${snapshot.meta.routeCountByPrefix.root})`,
  );
  console.log(
    `entries=${snapshot.entries.length} GET=${snapshot.meta.getRoutes} mutations covered=${snapshot.meta.mutationRoutesCovered}/${snapshot.meta.mutationRoutes}`,
  );
}

if (import.meta.main) {
  await main();
}
