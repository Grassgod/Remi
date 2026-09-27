// MUL-398: deterministic fixture for the repository-wikis summary route.
//
// `GET /api/workspaces/:id/repository-wikis` was measured at ~12.2 MB per
// request on 209 (`repositoryWikiObservability`'s `SELECT r.*`) plus ~10.8 MB
// from `listLatestRepositoryAutopilotRuns`, both dominated by the `payload` and
// `result` columns of `multiremi_autopilot_runs`. This seed reproduces that
// shape on a real PostgreSQL so before/after numbers come from one dataset.
//
// Production facts the defaults mirror:
//   - Repository Wiki pages live in OpenViking, so the control-plane row keeps
//     an empty `body` and only the storage pointer. Seeding bodies into the row
//     (`pageStorage: "sql"`) is available as a secondary shape.
//   - The observability query matches runs scoped by `repository_id` and runs
//     scoped only by a repository `schedule_target`, while the build-state query
//     additionally requires a compilation run for the schedule-only case. The
//     two statements therefore differ in row count, which is why 209 showed
//     12.2 MB and 10.8 MB for the same request.
//
// Everything is explicit and deterministic: no wall-clock ids, no randomness,
// so two runs over the same fixture version are byte-comparable.
import { performance } from "node:perf_hooks";
import type { MultiremiStore } from "@multiremi/store.js";

export const REPOSITORY_WIKIS_WORKSPACE_ID = "local";
export const REPOSITORY_WIKIS_REPOSITORY_ID = "repo_mul398_bridge";
export const REPOSITORY_WIKIS_SCHEDULE_ONLY_REPOSITORY_ID = "repo_mul398_scheduled";

export interface RepositoryWikisBridgeFixtureOptions {
  /** Repository Wiki pages attached to the primary repository. */
  pages?: number;
  /** Bytes of filler in each page body when `pageStorage` is `sql`. */
  pageBodyBytes?: number;
  /** Where page bodies live; `openviking` matches production. */
  pageStorage?: "openviking" | "sql";
  /** Completed runs scoped by `repository_id` (matched by both queries). */
  runs?: number;
  /** Completed runs scoped only by a repository `schedule_target` (observability only). */
  scheduleOnlyRuns?: number;
  /**
   * How many of the schedule-only runs also own a repository-scoped
   * compilation run. `listLatestRepositoryAutopilotRuns` requires that
   * provenance, so this is the knob that makes its row count (and therefore
   * its bridge payload) smaller than the observability query's.
   */
  scheduleOnlyCompilationRuns?: number;
  /** Bytes of the `payload` column on SCM-triggered runs. */
  runPayloadBytes?: number;
  /** Bytes of the `result` column on every run. */
  runResultBytes?: number;
  /**
   * Runs with a repository scope but no `dedupe_key`, i.e. rows created before
   * the Wiki dedupe key existed. Their `source_revision` can only come from
   * `payload`, so they are the rows a `payload` projection has to keep. The
   * primary fixture shape leaves this at 0; it exists to reproduce the legacy
   * path deliberately.
   */
  legacyRuns?: number;
  /** Compilation runs recorded against the primary repository. */
  compilationRuns?: number;
  /** Raw SQL executor for the caller's database. */
  run: (sql: string, params: unknown[]) => void;
}

export interface RepositoryWikisBridgeFixture {
  workspaceId: string;
  repositoryId: string;
  autopilotId: string;
  agentId: string;
  pageIds: string[];
  repositoryScopedRunIds: string[];
  scheduleOnlyRunIds: string[];
  legacyRunIds: string[];
  counts: {
    pages: number;
    pageStorage: "openviking" | "sql";
    pageBodyBytes: number;
    repositoryScopedRuns: number;
    scheduleOnlyRuns: number;
    legacyRuns: number;
    scheduleOnlyCompilationRuns: number;
    runPayloadBytes: number;
    runResultBytes: number;
    compilationRuns: number;
    /** Nominal (not JSON-encoded) bytes seeded into `payload`. */
    nominalPayloadBytes: number;
    /** Nominal (not JSON-encoded) bytes seeded into `result`. */
    nominalResultBytes: number;
  };
  seedMs: number;
}

/** Deterministic filler with a recognizable prefix so a leaked blob is greppable. */
export function filler(prefix: string, index: number, bytes: number): string {
  const head = `${prefix} #${index} `;
  if (bytes <= head.length) return head.slice(0, Math.max(0, bytes));
  return head + "lorem ipsum dolor sit amet consectetur ".repeat(Math.ceil(bytes / 40) + 1)
    .slice(0, bytes - head.length);
}

/**
 * `payload` shaped like the SCM event the Wiki automations really store:
 * `{ event: {...}, data: { files: [...] } }`, which is what made the column
 * multi-megabyte in production.
 */
export function scmRunPayload(index: number, bytes: number): Record<string, unknown> {
  const fileCount = 40;
  const perFile = Math.max(32, Math.floor((bytes - 400) / fileCount));
  return {
    event: {
      id: `sce_mul398_${String(index).padStart(4, "0")}`,
      type: index % 2 === 0 ? "change.merged" : "default_branch.updated",
      provider: "github",
      connectionId: "scm_mul398",
      repositoryId: REPOSITORY_WIKIS_REPOSITORY_ID,
      subjectType: "change",
      subjectId: String(1000 + index),
      occurredAt: "2026-09-26T06:00:00.000Z",
      observedAt: "2026-09-26T06:00:01.000Z",
      fidelity: "exact",
    },
    data: {
      number: 1000 + index,
      title: `MUL-398 fixture change ${index}`,
      target_branch: "main",
      merge_sha: `sha${String(index).padStart(6, "0")}`,
      files: Array.from({ length: fileCount }, (_, fileIndex) => ({
        path: `packages/server/src/fixture/file-${index}-${fileIndex}.ts`,
        additions: fileIndex * 3,
        deletions: fileIndex,
        patch: filler(`mul398-payload-${index}-${fileIndex}`, fileIndex, perFile),
      })),
    },
  };
}

/** `result` shaped like the task completion record the store writes. */
export function runResult(index: number, bytes: number): Record<string, unknown> {
  return {
    taskId: `tsk_mul398_${String(index).padStart(4, "0")}`,
    status: "completed",
    output: filler(`mul398-result-${index}`, index, Math.max(0, bytes - 200)),
    knowledge_outcome: { status: "published", reason: "Published repository Wiki changes" },
  };
}

/** Repository `schedule_target` JSON, the shape `parseJson` consumes. */
function repositoryScheduleTarget(repositoryId: string): string {
  return JSON.stringify({ kind: "repository", id: repositoryId });
}

export function seedRepositoryWikisBridgeFixture(
  store: MultiremiStore,
  options: RepositoryWikisBridgeFixtureOptions,
): RepositoryWikisBridgeFixture {
  const startedAt = performance.now();
  const pages = options.pages ?? 146;
  const pageBodyBytes = options.pageBodyBytes ?? 50_000;
  const pageStorage = options.pageStorage ?? "openviking";
  const runs = options.runs ?? 130;
  const scheduleOnlyRuns = options.scheduleOnlyRuns ?? 48;
  const scheduleOnlyCompilationRuns = options.scheduleOnlyCompilationRuns ?? 3;
  const legacyRuns = options.legacyRuns ?? 0;
  const runPayloadBytes = options.runPayloadBytes ?? 46_800;
  const runResultBytes = options.runResultBytes ?? 32_000;
  const compilationRuns = options.compilationRuns ?? 133;
  const run = options.run;

  store.ensureLocalWorkspace();
  if (!store.getWorkspaceMember("mem_local_local")) {
    const owner = store.getCurrentUser();
    store.createWorkspaceMember({
      id: "mem_local_local",
      workspaceId: REPOSITORY_WIKIS_WORKSPACE_ID,
      userId: owner.id,
      name: owner.name ?? "Owner",
      role: "owner",
    });
  }
  const owner = store.getCurrentUser();
  const agent = store.createAgent({
    id: "agt_mul398",
    name: "MUL-398 fixture agent",
    provider: "codex",
    workspaceId: REPOSITORY_WIKIS_WORKSPACE_ID,
    ownerId: owner.id,
    visibility: "workspace",
  });

  const workspace = store.getWorkspace(REPOSITORY_WIKIS_WORKSPACE_ID)!;
  const repositories = (workspace.repos ?? []) as Array<Record<string, unknown>>;
  const missing = [
    { id: REPOSITORY_WIKIS_REPOSITORY_ID, name: "mul398-bridge-fixture" },
    { id: REPOSITORY_WIKIS_SCHEDULE_ONLY_REPOSITORY_ID, name: "mul398-scheduled-fixture" },
  ].filter((candidate) => !repositories.some((existing) => existing.id === candidate.id));
  if (missing.length) {
    store.updateWorkspaceRepositories(REPOSITORY_WIKIS_WORKSPACE_ID, [...repositories, ...missing.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      url: `git@github.com:multiremi/${candidate.name}.git`,
      source: "github",
      default_branch: "main",
    }))]);
  }

  const pageIds: string[] = [];
  for (let index = 0; index < pages; index += 1) {
    const id = `rwdoc_mul398_${String(index).padStart(4, "0")}`;
    const body = pageStorage === "sql" ? filler(`mul398-page-${index}`, index, pageBodyBytes) : "";
    // OpenViking pages record the storage pointer with an empty row body, which
    // is why the docs statement never carried megabytes on 209.
    const control = pageStorage === "openviking"
      ? {
        contentUri: `viking://resources/local/repository-wiki/${REPOSITORY_WIKIS_REPOSITORY_ID}/fixture/page-${index}.md`,
        contentSha256: "0".repeat(64),
        snapshotOid: `snapshot-mul398-${index}`,
      }
      : undefined;
    const doc = store.createRepositoryWikiDoc(REPOSITORY_WIKIS_WORKSPACE_ID, REPOSITORY_WIKIS_REPOSITORY_ID, {
      id,
      path: `fixture/page-${String(index).padStart(3, "0")}.md`,
      title: `MUL-398 fixture page ${index}`,
      summary: `summary ${index}`,
      body,
      authorType: "agent",
      authorId: agent.id,
    }, control);
    pageIds.push(doc.id);
  }
  // `createRepositoryWikiDoc` stamps wall-clock time, which reaches the summary
  // response as `updated_at` / `last_published_at`. Pinning it keeps two runs of
  // this fixture byte-comparable, so the before/after response diff is a real
  // contract comparison instead of a normalizing argument.
  for (const [index, id] of pageIds.entries()) {
    const updatedAt = new Date(Date.UTC(2026, 8, 25, 12, 0, 0) - index * 60_000).toISOString();
    run(
      "UPDATE multiremi_repository_wiki_docs SET created_at = ?, updated_at = ? WHERE id = ?",
      [updatedAt, updatedAt, id],
    );
  }

  const autopilot = store.createAutopilot({
    id: "ap_mul398",
    title: "MUL-398 repository Wiki fixture",
    workspaceId: REPOSITORY_WIKIS_WORKSPACE_ID,
    assigneeId: agent.id,
    executionMode: "run_only",
    status: "active",
  });

  const insertRun = (
    id: string,
    index: number,
    scopedRepositoryId: string | null,
    scheduleTarget: string | null,
    payload: string,
    /** `undefined` derives the Wiki key from the repository; `null` leaves it unset. */
    dedupeKey?: string | null,
  ): void => {
    const createdAt = new Date(Date.UTC(2026, 8, 26, 5, 0, 0) - index * 60_000).toISOString();
    const completedAt = new Date(Date.UTC(2026, 8, 26, 5, 0, 30) - index * 60_000).toISOString();
    run(
      `INSERT INTO multiremi_autopilot_runs (
         id, autopilot_id, source, status, repository_id, dedupe_key, schedule_target,
         triggered_at, completed_at, failure_reason, payload, result, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        autopilot.id,
        "scm_event",
        "completed",
        scopedRepositoryId,
        dedupeKey !== undefined
          ? dedupeKey
          : scopedRepositoryId
            ? `${scopedRepositoryId}:incremental_update:sha${String(index).padStart(6, "0")}`
            : null,
        scheduleTarget,
        createdAt,
        completedAt,
        null,
        payload,
        JSON.stringify(runResult(index, runResultBytes)),
        createdAt,
      ],
    );
  };

  const repositoryScopedRunIds: string[] = [];
  for (let index = 0; index < runs; index += 1) {
    const id = `run_mul398_${String(index).padStart(4, "0")}`;
    insertRun(id, index, REPOSITORY_WIKIS_REPOSITORY_ID, null, JSON.stringify(scmRunPayload(index, runPayloadBytes)));
    repositoryScopedRunIds.push(id);
  }
  const scheduleOnlyRunIds: string[] = [];
  for (let index = 0; index < scheduleOnlyRuns; index += 1) {
    const id = `run_mul398_sched_${String(index).padStart(4, "0")}`;
    // Scheduler-enqueued runs persist only the cron context, never an SCM event.
    insertRun(
      id,
      runs + index,
      null,
      repositoryScheduleTarget(REPOSITORY_WIKIS_SCHEDULE_ONLY_REPOSITORY_ID),
      JSON.stringify({ timezone: "UTC", cronExpression: "0 9 * * *" }),
    );
    scheduleOnlyRunIds.push(id);
  }
  const legacyRunIds: string[] = [];
  for (let index = 0; index < legacyRuns; index += 1) {
    const id = `run_mul398_legacy_${String(index).padStart(4, "0")}`;
    // Pre-dedupe-key rows: their only source_revision is inside `payload`.
    insertRun(
      id,
      runs + scheduleOnlyRuns + index,
      REPOSITORY_WIKIS_REPOSITORY_ID,
      null,
      JSON.stringify(scmRunPayload(index, runPayloadBytes)),
      null,
    );
    legacyRunIds.push(id);
  }

  // Compilation runs give the observability query its `autopilot_run_id`
  // provenance and make a schedule-only row eligible for the build-state
  // query. Only a few schedule-only rows get one, which is what makes the two
  // statements differ in size the way 209 showed (12.2 MB vs 10.8 MB).
  const eligibleRunIds = [
    ...repositoryScopedRunIds,
    ...legacyRunIds,
    ...scheduleOnlyRunIds.slice(0, scheduleOnlyCompilationRuns),
  ];
  for (let index = 0; index < compilationRuns; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 8, 26, 5, 0, 0) - index * 60_000).toISOString();
    const autopilotRunId = eligibleRunIds[index] ?? null;
    if (!autopilotRunId) break;
    const scheduleOnly = index >= repositoryScopedRunIds.length;
    run(
      `INSERT INTO multiremi_knowledge_compilation_runs (
         id, workspace_id, project_id, repository_id, task_id, agent_id, autopilot_run_id,
         mode, status, result_summary, dedupe_key, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `krun_mul398_${String(index).padStart(4, "0")}`,
        REPOSITORY_WIKIS_WORKSPACE_ID,
        null,
        scheduleOnly ? REPOSITORY_WIKIS_SCHEDULE_ONLY_REPOSITORY_ID : REPOSITORY_WIKIS_REPOSITORY_ID,
        `tsk_mul398_${String(index).padStart(4, "0")}`,
        agent.id,
        autopilotRunId,
        "incremental_update",
        "published",
        "Published repository Wiki changes",
        null,
        createdAt,
        createdAt,
      ],
    );
  }

  return {
    workspaceId: REPOSITORY_WIKIS_WORKSPACE_ID,
    repositoryId: REPOSITORY_WIKIS_REPOSITORY_ID,
    autopilotId: autopilot.id,
    agentId: agent.id,
    pageIds,
    repositoryScopedRunIds,
    scheduleOnlyRunIds,
    legacyRunIds,
    counts: {
      pages,
      pageStorage,
      pageBodyBytes,
      repositoryScopedRuns: repositoryScopedRunIds.length,
      scheduleOnlyRuns: scheduleOnlyRunIds.length,
      legacyRuns: legacyRunIds.length,
      scheduleOnlyCompilationRuns,
      runPayloadBytes,
      runResultBytes,
      compilationRuns,
      nominalPayloadBytes: (repositoryScopedRunIds.length + legacyRunIds.length) * runPayloadBytes,
      nominalResultBytes: (repositoryScopedRunIds.length + scheduleOnlyRunIds.length + legacyRunIds.length) * runResultBytes,
    },
    seedMs: performance.now() - startedAt,
  };
}
