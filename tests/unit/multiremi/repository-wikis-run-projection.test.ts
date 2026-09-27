// MUL-398 A: the two `SELECT r.* FROM multiremi_autopilot_runs` statements the
// `GET /api/workspaces/:id/repository-wikis` route executes.
//
// These tests pin the *dependency surface* the projection has to preserve, not
// the projection itself (the projection lands with the MUL-386 merge):
//   - `result` is never read on this route;
//   - `payload` is read only through `autopilotRunSourceRevision`, i.e. when
//     `dedupe_key` is missing or ends in `:head`, and the fallback reaches
//     `payload.data.merge_sha`;
//   - the response contract (`source_revision`, `published`, observability
//     counters) is unchanged by a projection that keeps those columns.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { autopilotRunSourceRevision } from "@multiremi/store/repos/autopilots-repo.js";
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

/** Insert a completed run with an explicit dedupe key and payload. */
function insertRun(
  input: { id: string; autopilotId: string; dedupeKey: string | null; payload: unknown; createdAt: string },
): void {
  db!.run(
    `INSERT INTO multiremi_autopilot_runs (
       id, autopilot_id, source, status, repository_id, dedupe_key,
       triggered_at, completed_at, payload, result, created_at
     ) VALUES (?, ?, 'scm_event', 'completed', ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.autopilotId,
      REPOSITORY_ID,
      input.dedupeKey,
      input.createdAt,
      input.createdAt,
      JSON.stringify(input.payload),
      JSON.stringify({ taskId: "tsk_projection", output: "result filler" }),
      input.createdAt,
    ],
  );
}

describe("repository-wikis run projection surface", () => {
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
