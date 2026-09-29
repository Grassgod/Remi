// MUL-398 A: the two `SELECT r.* FROM multiremi_autopilot_runs` statements the
// `GET /api/workspaces/:id/repository-wikis` route executes are now projected.
//
// These tests pin both halves of that change:
//   - the SQL shape: no `r.*`, and no `result` column, on either statement;
//   - the dependency surface: `payload` is read only through
//     `autopilotRunSourceRevision`, i.e. when `dedupe_key` is missing or does
//     not pin a revision, and the fallback reaches `payload.data.merge_sha`.
//     A pinned run must come back with `payload: null`.
//   - the response contract (`source_revision`, `published`, observability
//     counters) and the blocked-Wiki alert path are unchanged.
import { afterEach, describe, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { autopilotRunSourceRevision } from "@multiremi/store/repos/autopilots-repo.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { configureRepositoryWikiAutomation, createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const REPOSITORY_ID = "repo_projection";
const rootHeaders = { Authorization: "Bearer root-secret" };

function fixture() {
  const store = createLocalStore();
  store.updateWorkspaceRepositories("local", [
    { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
  ]);
  const { agent, autopilot } = configureRepositoryWikiAutomation(store);
  return { store, agent, autopilot };
}

/** The sqlite handle to write through; tests may use their own recording store. */
type RunWriter = { run: (sql: string, ...params: unknown[]) => unknown };

/**
 * Insert a completed run with an explicit dedupe key and payload.
 *
 * `result` is always a non-empty JSON object: the projection asserts it is never
 * selected, so the row has to actually carry one for that to mean anything.
 */
function insertRun(
  input: {
    id: string;
    autopilotId: string;
    dedupeKey: string | null;
    payload: unknown;
    createdAt: string;
    repositoryId?: string;
  },
  writer: RunWriter | null = null,
): void {
  const target = (writer ?? (db as unknown as RunWriter))!;
  target.run(
    `INSERT INTO multiremi_autopilot_runs (
       id, autopilot_id, source, status, repository_id, dedupe_key,
       triggered_at, completed_at, payload, result, created_at
     ) VALUES (?, ?, 'scm_event', 'completed', ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.autopilotId,
    input.repositoryId ?? REPOSITORY_ID,
    input.dedupeKey,
    input.createdAt,
    input.createdAt,
    JSON.stringify(input.payload),
    JSON.stringify({ taskId: "tsk_projection", output: "result filler" }),
    input.createdAt,
  );
}

/**
 * `createLocalStore`, but every statement is recorded.
 *
 * The projection is a property of the SQL text, so the assertions have to read
 * the statements the store actually issues rather than infer them from results.
 */
function createRecordingStore(): { store: MultiremiStore; sql: string[]; raw: RunWriter } {
  const sql: string[] = [];
  const raw = openSqliteDatabase(":memory:");
  const db: SqlDatabase = new Proxy(raw as unknown as SqlDatabase, {
    get(target, property) {
      const value = target[property as keyof SqlDatabase];
      if (property === "query" || property === "prepare") {
        return (text: string) => {
          sql.push(text);
          return (target[property] as (t: string) => SqlStatement)(text);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SqlDatabase;
  return { store: new MultiremiStore(db), sql, raw: raw as unknown as RunWriter };
}

/** Every statement that reads the run table, normalized to one line. */
function runStatements(sql: string[]): string[] {
  return sql
    .filter((statement) => /multiremi_autopilot_runs/i.test(statement))
    .map((statement) => statement.replace(/\s+/g, " ").trim());
}

/** The two projected statements, selected out of the run statements. */
function projectedStatements(sql: string[]): { repositoryWiki: string; listLatest: string } {
  const statements = runStatements(sql);
  const repositoryWiki = statements.find((statement) => /SELECT r\.id, r\.repository_id/.test(statement));
  const listLatest = statements.find((statement) => /CASE WHEN r\.dedupe_key IS NULL/.test(statement));
  expect(repositoryWiki, `no observability projection found in: ${statements.join(" | ")}`).toBeDefined();
  expect(listLatest, `no listLatest projection found in: ${statements.join(" | ")}`).toBeDefined();
  return { repositoryWiki: repositoryWiki!, listLatest: listLatest! };
}

describe("repository-wikis run projection surface", () => {
  it("issues neither statement as `SELECT r.*` and never selects `result`", async () => {
    const { store, sql, raw } = createRecordingStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [
      { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
    ]);
    const { autopilot } = configureRepositoryWikiAutomation(store);
    insertRun({
      id: "run_projection_sql", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:sha-sql`,
      payload: { data: { merge_sha: "sha-sql" } }, createdAt: "2026-09-20T00:00:00.000Z",
    }, raw);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: rootHeaders });
    expect(response.status).toBe(200);
    const { repositoryWiki, listLatest } = projectedStatements(sql);

    // The regression this change exists to prevent: a whole-row read makes the
    // multi-megabyte `payload` / `result` columns cross the PG bridge again.
    for (const statement of [repositoryWiki, listLatest]) {
      expect(statement).not.toMatch(/SELECT r\.\*/);
      expect(statement).not.toMatch(/SELECT \*/);
      expect(statement).not.toMatch(/\br\.result\b/);
    }

    // Observability reads exactly the six columns it consumes; `status` is a
    // WHERE filter and must not be projected back.
    expect(repositoryWiki).toMatch(
      /^SELECT r\.id, r\.repository_id, r\.schedule_target, r\.task_id, r\.completed_at, r\.created_at FROM multiremi_autopilot_runs r/,
    );
    expect(repositoryWiki).not.toMatch(/\br\.status\b(?! IN)/);

    // The build-state query keeps every scalar column `toAutopilotRun()` maps,
    // drops `result`, and gates `payload` behind the dedupe-key guard.
    for (const column of ["r.id", "r.autopilot_id", "r.source", "r.status", "r.issue_id", "r.task_id",
      "r.trigger_id", "r.event_id", "r.issue_session_id", "r.repository_id", "r.dedupe_key",
      "r.schedule_target", "r.schedule_batch_id", "r.triggered_at", "r.completed_at",
      "r.failure_reason", "r.created_at"]) {
      expect(listLatest).toContain(column);
    }
    expect(listLatest).toMatch(/CASE WHEN r\.dedupe_key IS NULL/);
    expect(listLatest).toMatch(/THEN r\.payload ELSE NULL END AS payload/);
  });

  it("returns a null payload for a run whose dedupe key pins the revision", async () => {
    const { store, autopilot } = fixture();
    insertRun({
      id: "run_projection_pinned_payload", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:sha-pinned`,
      payload: { data: { merge_sha: "sha-that-must-not-be-read" } },
      createdAt: "2026-09-20T00:00:00.000Z",
    });

    // The guard's whole purpose: a pinned run must not pay the bridge cost.
    const runs = store.listLatestRepositoryAutopilotRuns("local");
    expect(runs.map((run) => run.id)).toContain("run_projection_pinned_payload");
    expect(runs.find((run) => run.id === "run_projection_pinned_payload")?.payload).toBeNull();
    // `result` is gone for every run, pinned or not.
    expect(runs.every((run) => run.result === null)).toBe(true);
  });

  it("keeps the payload for every run whose key does not pin a revision", async () => {
    const { store, autopilot } = fixture();
    // One repository per case: the method keeps only the newest run per
    // repository, so sharing one would hide three of the four.
    const cases: Array<{ id: string; dedupeKey: string | null; sha: string }> = [
      { id: "run_guard_null", dedupeKey: null, sha: "sha-null" },
      { id: "run_guard_head", dedupeKey: "repo:incremental_update:head", sha: "sha-head" },
      // Keys the function still consults payload for even though they are not the
      // `:head` case the issue text names. These are why the SQL guard is a
      // superset instead of the literal `IS NULL OR LIKE '%:head'`.
      { id: "run_guard_short", dedupeKey: "repo:incremental_update", sha: "sha-short" },
      { id: "run_guard_trailing", dedupeKey: "repo:incremental_update:", sha: "sha-trailing" },
    ];
    const repositories = cases.map((entry, index) => ({
      id: `repo_guard_${index}`,
      name: `Guard ${index}`,
      url: `https://github.com/acme/guard-${index}.git`,
      source: "github" as const,
    }));
    store.updateWorkspaceRepositories("local", [
      { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
      ...repositories,
    ]);
    for (const [index, entry] of cases.entries()) {
      insertRun({
        id: entry.id,
        autopilotId: autopilot.id,
        dedupeKey: entry.dedupeKey?.replace(/^repo/, repositories[index]!.id) ?? null,
        payload: { data: { merge_sha: entry.sha } },
        createdAt: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
        repositoryId: repositories[index]!.id,
      });
    }

    const runs = store.listLatestRepositoryAutopilotRuns("local");
    const byId = new Map(runs.map((run) => [run.id, run]));
    for (const entry of cases) {
      const run = byId.get(entry.id);
      expect(run, `run ${entry.id} missing`).toBeDefined();
      expect(run!.payload, `payload dropped for ${entry.id}`).not.toBeNull();
      expect(autopilotRunSourceRevision(run!)).toBe(entry.sha);
    }
  });

  it("derives source_revision from dedupe_key when present, and from payload only for legacy or :head keys", () => {
    expect(autopilotRunSourceRevision({ dedupeKey: "repo_projection:incremental_update:sha-pinned", payload: null }))
      .toBe("sha-pinned");
    // `:head` is a moving target, so the pinned segment is not a revision and the
    // SCM payload is the only remaining source. This is the projection constraint.
    expect(autopilotRunSourceRevision({
      dedupeKey: "repo_projection:incremental_update:head",
      payload: { data: { merge_sha: "sha-from-payload" } },
    })).toBe("sha-from-payload");
    expect(autopilotRunSourceRevision({
      dedupeKey: null,
      payload: { data: { head_sha: "sha-legacy" } },
    })).toBe("sha-legacy");
    expect(autopilotRunSourceRevision({ dedupeKey: null, payload: null })).toBeNull();
  });

  it("keeps source_revision, published and observability counters in the summary response", async () => {
    const { store, autopilot } = fixture();
    insertRun({
      id: "run_projection_pinned",
      autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:sha-pinned`,
      payload: { data: { merge_sha: "sha-from-payload" } },
      createdAt: "2026-09-20T00:00:00.000Z",
    });
    const doc = store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "index.md", title: "Index", body: "page", sourceRevision: "sha-pinned",
    });
    // Pin the publication clock: `createRepositoryWikiDoc` stamps wall-clock time,
    // and builds_since_publish compares the run against it.
    db!.run("UPDATE multiremi_repository_wiki_docs SET updated_at = ? WHERE id = ?", ["2026-09-19T00:00:00.000Z", doc.id]);

    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: rootHeaders });
    expect(response.status).toBe(200);
    const summary = (await response.json() as any).repositories
      .find((entry: any) => entry.repository_id === REPOSITORY_ID);

    // A pinned dedupe key wins over the payload, so a projection that nulls
    // `payload` for pinned keys must not change this field.
    expect(summary.build.source_revision).toBe("sha-pinned");
    // Publication is proven by the doc revision, not by `result` text.
    expect(summary.build.published).toBe(true);
    expect(summary).toMatchObject({
      status: "healthy",
      page_count: 1,
      last_published_at: "2026-09-19T00:00:00.000Z",
      // The run has no compilation record, so the observability query cannot
      // attribute a publication to it and counts it as a build since publish.
      // That is the pre-existing semantic; the projection must not change it.
      builds_since_publish: 1,
      consecutive_blocked: 0,
      alert: null,
    });
  });

  it("keeps the payload-derived revision for a legacy run without a dedupe key", async () => {
    const { store, autopilot } = fixture();
    insertRun({
      id: "run_projection_legacy",
      autopilotId: autopilot.id,
      dedupeKey: null,
      payload: { data: { merge_sha: "sha-legacy" } },
      createdAt: "2026-09-21T00:00:00.000Z",
    });
    const doc = store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "index.md", title: "Index", body: "page", sourceRevision: "sha-legacy",
    });
    db!.run("UPDATE multiremi_repository_wiki_docs SET updated_at = ? WHERE id = ?", ["2026-09-20T00:00:00.000Z", doc.id]);

    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: rootHeaders });
    const summary = (await response.json() as any).repositories
      .find((entry: any) => entry.repository_id === REPOSITORY_ID);

    expect(summary.build.source_revision).toBe("sha-legacy");
    expect(summary.build.published).toBe(true);
  });

  it("does not read the run result to decide publication", async () => {
    const { store, autopilot } = fixture();
    insertRun({
      id: "run_projection_unpublished",
      autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:sha-absent`,
      payload: { data: { merge_sha: "sha-absent" } },
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    // No matching doc revision: the run completed with a success-looking result,
    // which must not be trusted as publication evidence.
    const doc = store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "index.md", title: "Index", body: "page", sourceRevision: "some-other-revision",
    });
    db!.run("UPDATE multiremi_repository_wiki_docs SET updated_at = ? WHERE id = ?", ["2026-09-20T00:00:00.000Z", doc.id]);

    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: rootHeaders });
    const summary = (await response.json() as any).repositories
      .find((entry: any) => entry.repository_id === REPOSITORY_ID);

    expect(summary.build.published).toBe(false);
    expect(summary.builds_since_publish).toBe(1);
  });
});

describe("repository-wikis A2: the remaining per-repository reads", () => {
  /**
   * Statements the summary route issues, normalized to one line. A2 asserts on
   * SQL shape because the point of the change is which columns cross the PG
   * bridge; results alone cannot show that.
   */
  function summaryStatements(sql: string[]): string[] {
    return sql.map((statement) => statement.replace(/\s+/g, " ").trim());
  }

  it("decides publication from a narrow projection instead of the whole run row", async () => {
    const { store, sql, raw } = createRecordingStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [
      { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
    ]);
    const { autopilot } = configureRepositoryWikiAutomation(store);
    insertRun({
      id: "run_a2_published", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:sha-a2`,
      payload: { data: { merge_sha: "sha-a2" } },
      createdAt: "2026-09-20T00:00:00.000Z",
    }, raw);
    const doc = store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "index.md", title: "Index", body: "page", sourceRevision: "sha-a2",
    });
    raw.run("UPDATE multiremi_repository_wiki_docs SET updated_at = ? WHERE id = ?", ["2026-09-19T00:00:00.000Z", doc.id]);

    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: rootHeaders });
    expect(response.status).toBe(200);
    const summary = (await response.json() as any).repositories
      .find((entry: any) => entry.repository_id === REPOSITORY_ID);
    expect(summary.build.published).toBe(true);

    const statements = summaryStatements(sql);
    // The regression this guards: the publication decision used to load the run
    // through `getAutopilotRun`, whose `SELECT *` ships `payload` + `result` for
    // every repository. That must not appear on the summary path any more.
    const wholeRowRunReads = statements.filter((statement) => /^SELECT \* FROM multiremi_autopilot_runs WHERE id = \?$/.test(statement));
    expect(wholeRowRunReads).toEqual([]);

    const probe = statements.find((statement) => /^SELECT r\.repository_id, r\.schedule_target, r\.task_id, r\.dedupe_key,/.test(statement));
    expect(probe, `no narrow publication probe in: ${statements.join(" | ")}`).toBeDefined();
    expect(probe).toMatch(/CASE WHEN r\.dedupe_key IS NULL/);
    expect(probe).not.toMatch(/\br\.result\b/);
    expect(probe).not.toMatch(/r\.\*/);
  });

  it("keeps the publication answer identical to the whole-row implementation", async () => {
    const { store, autopilot } = fixture();
    const insert = (input: { id: string; dedupeKey: string | null; payload: unknown; repositoryId?: string }) =>
      insertRun({
        id: input.id, autopilotId: autopilot.id, dedupeKey: input.dedupeKey, payload: input.payload,
        createdAt: "2026-09-20T00:00:00.000Z", repositoryId: input.repositoryId,
      });

    // A task-attributed publication, a revision-attributed one, and a miss.
    const taskRun = store.runAutopilot(autopilot.id, {
      source: "api", repositoryId: REPOSITORY_ID, dedupeKey: `${REPOSITORY_ID}:bootstrap_repository:head`,
    });
    store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "task.md", title: "Task publication", sourceTaskId: taskRun.taskId,
    });
    expect(store.isRepositoryWikiRunPublished(taskRun.id)).toBe(true);

    insert({ id: "run_a2_revision", dedupeKey: "repo_a2_rev:incremental_update:abc123", payload: { data: { merge_sha: "abc123" } }, repositoryId: "repo_a2_rev" });
    expect(store.isRepositoryWikiRunPublished("run_a2_revision")).toBe(false);
    store.createRepositoryWikiDoc("local", "repo_a2_rev", {
      path: "rev.md", title: "Revision publication", sourceRevision: "abc123",
    });
    expect(store.isRepositoryWikiRunPublished("run_a2_revision")).toBe(true);

    // A legacy run with no dedupe key: the revision can only come from payload,
    // so the narrow probe has to keep reading that column for these rows.
    const legacy = store.runAutopilot(autopilot.id, {
      source: "scm_event", repositoryId: "repo_a2_legacy",
      dedupeKey: "repo_a2_legacy:incremental_update:head",
      payload: { data: { merge_sha: "sha-legacy-head" } },
    });
    expect(store.isRepositoryWikiRunPublished(legacy.id)).toBe(false);
    store.createRepositoryWikiDoc("local", "repo_a2_legacy", {
      path: "legacy.md", title: "Legacy publication", sourceRevision: "sha-legacy-head",
    });
    expect(store.isRepositoryWikiRunPublished(legacy.id)).toBe(true);
  });

  it("never reads a run row that resolves publication by schedule target alone", async () => {
    const { store, autopilot } = fixture();
    // A run scoped only by its schedule target still has to answer, which the old
    // code handled via `getAutopilotRun` + the scheduleTarget fallback.
    const run = store.runAutopilot(autopilot.id, { source: "manual" });
    store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "schedule.md", title: "Schedule publication", sourceTaskId: run.taskId,
    });
    // No repository scope anywhere: false, and no throw.
    expect(store.isRepositoryWikiRunPublished(run.id)).toBe(false);
    expect(store.isRepositoryWikiRunPublished("run_does_not_exist")).toBe(false);
  });

  it("lists workspace docs without selecting the body column", async () => {
    const { store, sql, raw } = createRecordingStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [
      { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
    ]);
    configureRepositoryWikiAutomation(store);
    const doc = store.createRepositoryWikiDoc("local", REPOSITORY_ID, {
      path: "index.md", title: "Index", body: "content that must not cross the bridge",
    });
    raw.run("UPDATE multiremi_repository_wiki_docs SET updated_at = ? WHERE id = ?", ["2026-09-20T00:00:00.000Z", doc.id]);
    sql.length = 0;

    const docs = store.listWorkspaceRepositoryWikiDocs("local");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: doc.id, path: "index.md", title: "Index", body: "" });

    const docsStatement = sql.map((statement) => statement.replace(/\s+/g, " ").trim())
      .find((statement) => /FROM multiremi_repository_wiki_docs/.test(statement) && /ORDER BY updated_at DESC/.test(statement));
    expect(docsStatement, `no workspace docs statement in: ${sql.join(" | ")}`).toBeDefined();
    expect(docsStatement).not.toMatch(/\bbody\b/);
    expect(docsStatement).not.toMatch(/SELECT \*/);
  });

  it("skips schedule-only runs that no compilation row references, without changing the counters", async () => {
    const { store, sql, raw } = createRecordingStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [
      { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
    ]);
    const { autopilot } = configureRepositoryWikiAutomation(store);

    // A schedule-only run that nothing references: the loop below always skipped
    // it, so the statement must not ship it any more.
    const orphan = store.runAutopilot(autopilot.id, { source: "manual" });
    raw.run(
      `UPDATE multiremi_autopilot_runs SET schedule_target = ?, repository_id = NULL,
         status = 'completed', completed_at = ? WHERE id = ?`,
      [JSON.stringify({ kind: "repository", id: REPOSITORY_ID }), "2026-09-18T00:00:00.000Z", orphan.id],
    );
    // A schedule-only run WITH a repository-scoped compilation record: the loop
    // does consume it, so it must stay in the result set.
    const referenced = store.runAutopilot(autopilot.id, { source: "manual" });
    raw.run(
      `UPDATE multiremi_autopilot_runs SET schedule_target = ?, repository_id = NULL,
         status = 'completed', completed_at = ? WHERE id = ?`,
      [JSON.stringify({ kind: "repository", id: REPOSITORY_ID }), "2026-09-19T00:00:00.000Z", referenced.id],
    );
    raw.run(
      `INSERT INTO multiremi_knowledge_compilation_runs (
         id, workspace_id, project_id, repository_id, task_id, agent_id, autopilot_run_id,
         mode, status, result_summary, dedupe_key, created_at, completed_at
       ) VALUES (?, 'local', NULL, ?, NULL, NULL, ?, 'incremental_update', 'published', 'Published', NULL, ?, ?)`,
      "krun_a2_schedule_only", REPOSITORY_ID, referenced.id,
      "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z",
    );
    sql.length = 0;

    const observability = store.repositoryWikiObservability("local");
    expect(observability[REPOSITORY_ID]).toMatchObject({ builds_since_publish: 1, consecutive_blocked: 0 });
    // A schedule-only run carries no task, so it contributes nothing to
    // `latest_completed_outcome`; the referenced run still counts a build.
    expect(observability[REPOSITORY_ID]!.latest_completed_outcome).toBeNull();

    const statement = sql.map((entry) => entry.replace(/\s+/g, " ").trim())
      .find((entry) => /^SELECT r\.id, r\.repository_id, r\.schedule_target, r\.task_id, r\.completed_at, r\.created_at/.test(entry));
    expect(statement, `no observability statement in: ${sql.join(" | ")}`).toBeDefined();
    // The row-reduction predicate: schedule-only runs only survive when a
    // repository-scoped compilation row references them.
    expect(statement).toMatch(/r\.schedule_target IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM multiremi_knowledge_compilation_runs k WHERE k\.autopilot_run_id = r\.id AND k\.repository_id IS NOT NULL AND k\.workspace_id = \?\)\)\)/);
  });

  it("ranks runs in SQL so only the latest row per repository crosses the bridge", async () => {
    const { store, sql, raw } = createRecordingStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [
      { id: REPOSITORY_ID, name: "Projection", url: "https://github.com/acme/projection.git", source: "github" },
    ]);
    const { autopilot } = configureRepositoryWikiAutomation(store);
    insertRun({
      id: "run_a2_one", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:one`,
      payload: { data: { merge_sha: "one" } }, createdAt: "2026-09-20T00:00:00.000Z",
    }, raw);
    sql.length = 0;
    store.listLatestRepositoryAutopilotRuns("local");

    // Shape guard: the ranking has to happen in SQL. Dropping it still returns
    // the right rows on a one-repository fixture, but it ships every run row
    // across the bridge again, which is the cost this change exists to remove.
    const listStatement = sql.map((entry) => entry.replace(/\s+/g, " ").trim())
      .find((entry) => /repository_rank|CASE WHEN r\.dedupe_key IS NULL/.test(entry) && /THEN r\.payload ELSE NULL END AS payload/.test(entry));
    expect(listStatement, `no build-state statement in: ${sql.join(" | ")}`).toBeDefined();
    expect(listStatement).toMatch(/ROW_NUMBER\(\) OVER \(\s*PARTITION BY COALESCE\(r\.repository_id, r\.schedule_target\)/);
    expect(listStatement).toMatch(/WHERE r\.repository_rank = 1/);
  });

  it("keeps the latest run per repository when several rows compete", async () => {
    const { store, autopilot } = fixture();
    // Two runs for one repository: only the newer one may come back, and the
    // statement must not return both for TypeScript to discard.
    insertRun({
      id: "run_a2_newer", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:newer`,
      payload: { data: { merge_sha: "newer" } }, createdAt: "2026-09-21T00:00:00.000Z",
    });
    insertRun({
      id: "run_a2_older", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:older`,
      payload: { data: { merge_sha: "older" } }, createdAt: "2026-09-20T00:00:00.000Z",
    });

    const runs = store.listLatestRepositoryAutopilotRuns("local");
    expect(runs.map((run) => run.id)).toEqual(["run_a2_newer"]);
  });

  it("picks the newest run when a repository spans repository_id and schedule_target rows", async () => {
    const { store, autopilot } = fixture();
    // A renamed repository leaves older runs scoped by `schedule_target` while
    // newer ones carry `repository_id`. The SQL ranking partitions on those two
    // shapes separately, so both candidates come back and the loop has to settle
    // them — this is the case that made the ranking safe to push into SQL.
    db!.run(
      `INSERT INTO multiremi_autopilot_runs (
         id, autopilot_id, source, status, repository_id, schedule_target, dedupe_key,
         triggered_at, completed_at, payload, result, created_at
       ) VALUES (?, ?, 'scm_event', 'completed', NULL, ?, NULL, ?, ?, NULL, NULL, ?)`,
      [
        "run_a2_old_scope", autopilot.id, JSON.stringify({ kind: "repository", id: REPOSITORY_ID }),
        "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z",
      ],
    );
    insertRun({
      id: "run_a2_new_scope", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:new`, payload: { data: { merge_sha: "new" } },
      createdAt: "2026-09-21T00:00:00.000Z",
    });

    const runs = store.listLatestRepositoryAutopilotRuns("local");
    expect(runs.map((run) => run.id)).toEqual(["run_a2_new_scope"]);
    expect(runs[0]!.repositoryId).toBe(REPOSITORY_ID);
  });

  it("prefers a still-active run when a completed run shares its created_at", async () => {
    const { store, autopilot } = fixture();
    const createdAt = "2026-09-22T00:00:00.000Z";
    insertRun({ id: "run_a2_completed", autopilotId: autopilot.id,
      dedupeKey: `${REPOSITORY_ID}:incremental_update:done`, payload: { data: { merge_sha: "done" } }, createdAt });
    db!.run(
      `INSERT INTO multiremi_autopilot_runs (
         id, autopilot_id, source, status, repository_id, dedupe_key, triggered_at, completed_at, payload, result, created_at
       ) VALUES (?, ?, 'scm_event', 'running', ?, ?, ?, NULL, ?, NULL, ?)`,
      [
        "run_a2_active", autopilot.id, REPOSITORY_ID,
        `${REPOSITORY_ID}:incremental_update:active`, createdAt,
        JSON.stringify({ data: { merge_sha: "active" } }), createdAt,
      ],
    );

    const runs = store.listLatestRepositoryAutopilotRuns("local");
    // The route's existing rule: on a created_at tie a still-active run wins, so
    // the summary keeps reporting the queued/building build instead of flipping
    // to the finished one. The SQL ranking has to preserve that.
    expect(runs.map((run) => run.id)).toEqual(["run_a2_active"]);
  });
});
