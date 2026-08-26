// Sibling test for packages/server/src/store/repos/runtime-request-queue.ts.
//
// The queue replaced five verbatim copies of get/claim/expire that used to live in
// runtimes-repo.ts. Two things have to hold:
//   1. the SQL it emits is byte-identical to what those copies emitted (golden strings below,
//      transcribed from the pre-refactor source), and
//   2. the lifecycle it implements — claim oldest-first, expire on either deadline — still works.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { RuntimesRepo } from "@multiremi/store/repos/runtimes-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

/** SQL text recorded by {@link createRepo}, in issue order. */
let sqlLog: string[] = [];

/** Wraps the bun:sqlite handle so every statement the repo prepares/runs is recorded verbatim. */
function recordingDb(target: Database): Database {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === "query" || prop === "prepare" || prop === "run" || prop === "exec") {
        return (sql: string, ...rest: unknown[]) => {
          sqlLog.push(sql);
          return (value as Function).call(obj, sql, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(obj) : value;
    },
  }) as Database;
}

function createRepo(): RuntimesRepo {
  const raw = new Database(":memory:");
  db = raw;
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(raw);
  const ctx = new StoreContext(recordingDb(raw), () => store!);
  ctx.registerAnalytics(new AnalyticsRepo(ctx));
  const repo = new RuntimesRepo(ctx);
  repo.registerRuntime({ id: "rt_q", name: "Q", provider: "claude", workspaceId: "local" });
  sqlLog = [];
  return repo;
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
  sqlLog = [];
});

// ── golden SQL ────────────────────────────────────────────────────────────────
// Continuation lines in the original template literals were indented seven columns.
const NL = "\n       ";

function goldenGet(table: string): string {
  return `SELECT * FROM ${table} WHERE id = ? AND runtime_id = ?`;
}
function goldenClaimSelect(table: string, limit: "1" | "?"): string {
  return `SELECT * FROM ${table}${NL}WHERE runtime_id = ? AND status = 'pending'${NL}ORDER BY created_at ASC${NL}LIMIT ${limit}`;
}
function goldenClaimUpdate(table: string): string {
  return `UPDATE ${table} SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?`;
}
function goldenExpirePending(table: string, message: string): string {
  return `UPDATE ${table}${NL}SET status = 'timeout', error = '${message}', updated_at = ?${NL}WHERE runtime_id = ? AND status = 'pending' AND created_at < ?`;
}
function goldenExpireRunning(table: string, message: string): string {
  return `UPDATE ${table}${NL}SET status = 'timeout', error = '${message}', updated_at = ?${NL}WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?`;
}

const DID_NOT_FINISH_60 = "daemon did not finish within 60 seconds";

interface Family {
  name: string;
  table: string;
  pendingTimeoutError: string;
  runningTimeoutError: string;
  /** Runs the family's create → get → claim path and returns nothing observable. */
  drive: (repo: RuntimesRepo) => void;
  /** `claimBatchIds` (LIMIT ?) instead of `claim` (LIMIT 1). */
  batchClaim?: boolean;
}

const FAMILIES: Family[] = [
  {
    name: "model list",
    table: "multiremi_runtime_model_list_requests",
    pendingTimeoutError: "daemon did not respond within 30 seconds",
    runningTimeoutError: DID_NOT_FINISH_60,
    drive: (repo) => {
      const request = repo.createRuntimeModelListRequest("rt_q");
      repo.getRuntimeModelListRequest("rt_q", request.id);
      repo.claimRuntimeModelListRequest("rt_q");
    },
  },
  {
    name: "directory scan",
    table: "multiremi_runtime_directory_scan_requests",
    pendingTimeoutError: "daemon did not respond within 3 minutes; the runtime daemon may need updating",
    runningTimeoutError: DID_NOT_FINISH_60,
    drive: (repo) => {
      const request = repo.createRuntimeDirectoryScanRequest("rt_q", { root: "/tmp" });
      repo.getRuntimeDirectoryScanRequest("rt_q", request.id);
      repo.claimRuntimeDirectoryScanRequest("rt_q");
    },
  },
  {
    name: "update",
    table: "multiremi_runtime_update_requests",
    pendingTimeoutError: "daemon did not respond within 120 seconds",
    runningTimeoutError: "update did not complete within 150 seconds",
    drive: (repo) => {
      const request = repo.createRuntimeUpdateRequest("rt_q", { targetVersion: "1.2.3" });
      repo.getRuntimeUpdateRequest("rt_q", request.id);
      repo.claimRuntimeUpdateRequest("rt_q");
    },
  },
  {
    name: "local skill list",
    table: "multiremi_runtime_local_skill_list_requests",
    pendingTimeoutError: "daemon did not respond within 3 minutes",
    runningTimeoutError: DID_NOT_FINISH_60,
    drive: (repo) => {
      const request = repo.createRuntimeLocalSkillListRequest("rt_q");
      repo.getRuntimeLocalSkillListRequest("rt_q", request.id);
      repo.claimRuntimeLocalSkillListRequest("rt_q");
    },
  },
  {
    name: "local skill import",
    table: "multiremi_runtime_local_skill_import_requests",
    pendingTimeoutError: "daemon did not respond within 3 minutes",
    runningTimeoutError: DID_NOT_FINISH_60,
    batchClaim: true,
    drive: (repo) => {
      const request = repo.createRuntimeLocalSkillImportRequest("rt_q", { skillKey: "k1" });
      repo.getRuntimeLocalSkillImportRequest("rt_q", request.id);
      repo.claimRuntimeLocalSkillImportRequests("rt_q", 5);
    },
  },
  {
    name: "runtime command",
    table: "multiremi_runtime_command_requests",
    pendingTimeoutError: "daemon did not respond within 3 minutes",
    runningTimeoutError: "daemon did not finish the command within 20 minutes",
    drive: (repo) => {
      const request = repo.createRuntimeCommandRequest("rt_q", { command: "printf ready" });
      repo.getRuntimeCommandRequest("rt_q", request.id);
      repo.claimRuntimeCommandRequest("rt_q");
    },
  },
];

describe("RuntimeRequestQueue SQL", () => {
  for (const family of FAMILIES) {
    it(`emits the pre-refactor statements for the ${family.name} family`, () => {
      const repo = createRepo();
      family.drive(repo);

      const emitted = new Set(sqlLog.filter((sql) => sql.includes(family.table)));
      for (const expected of [
        goldenGet(family.table),
        goldenClaimSelect(family.table, family.batchClaim ? "?" : "1"),
        goldenClaimUpdate(family.table),
        goldenExpirePending(family.table, family.pendingTimeoutError),
        goldenExpireRunning(family.table, family.runningTimeoutError),
      ]) {
        expect(emitted).toContain(expected);
      }
      // No other family's table may be touched — the specs must not have been crossed over.
      const otherTables = FAMILIES.filter((entry) => entry.table !== family.table).map((entry) => entry.table);
      for (const sql of sqlLog) {
        for (const other of otherTables) expect(sql).not.toContain(other);
      }
    });
  }

  it("matches the model-list statements character for character", () => {
    const repo = createRepo();
    FAMILIES[0]!.drive(repo);
    const emitted = new Set(sqlLog);

    // Copied verbatim out of the five hand-written families this template replaced.
    expect(emitted).toContain("SELECT * FROM multiremi_runtime_model_list_requests WHERE id = ? AND runtime_id = ?");
    expect(emitted).toContain(
      "UPDATE multiremi_runtime_model_list_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
    );
    expect(emitted).toContain(
      "SELECT * FROM multiremi_runtime_model_list_requests\n" +
        "       WHERE runtime_id = ? AND status = 'pending'\n" +
        "       ORDER BY created_at ASC\n" +
        "       LIMIT 1",
    );
    expect(emitted).toContain(
      "UPDATE multiremi_runtime_model_list_requests\n" +
        "       SET status = 'timeout', error = 'daemon did not respond within 30 seconds', updated_at = ?\n" +
        "       WHERE runtime_id = ? AND status = 'pending' AND created_at < ?",
    );
    expect(emitted).toContain(
      "UPDATE multiremi_runtime_model_list_requests\n" +
        "       SET status = 'timeout', error = 'daemon did not finish within 60 seconds', updated_at = ?\n" +
        "       WHERE runtime_id = ? AND status = 'running' AND run_started_at IS NOT NULL AND run_started_at < ?",
    );
  });
});

describe("RuntimeRequestQueue lifecycle", () => {
  it("claims the oldest pending request and leaves later ones alone", () => {
    const repo = createRepo();
    const first = repo.createRuntimeLocalSkillImportRequest("rt_q", { skillKey: "a" });
    const second = repo.createRuntimeLocalSkillImportRequest("rt_q", { skillKey: "b" });
    // Backdated inside the 3-minute pending deadline, so it is older but not yet expired.
    db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 10_000).toISOString(),
      second.id,
    ]);

    const claimed = repo.claimRuntimeLocalSkillImportRequests("rt_q", 1);
    expect(claimed.map((entry) => entry.id)).toEqual([second.id]);
    expect(repo.getRuntimeLocalSkillImportRequest("rt_q", first.id)?.status).toBe("pending");
  });

  it("honours the batch limit and floors it at one", () => {
    const repo = createRepo();
    repo.createRuntimeLocalSkillImportRequest("rt_q", { skillKey: "a" });
    repo.createRuntimeLocalSkillImportRequest("rt_q", { skillKey: "b" });
    repo.createRuntimeLocalSkillImportRequest("rt_q", { skillKey: "c" });

    expect(repo.claimRuntimeLocalSkillImportRequests("rt_q", 0)).toHaveLength(1);
    expect(repo.claimRuntimeLocalSkillImportRequests("rt_q", 10)).toHaveLength(2);
    expect(repo.claimRuntimeLocalSkillImportRequests("rt_q", 10)).toEqual([]);
  });

  it("times out a pending request past its own deadline", () => {
    const repo = createRepo();
    // The model-list family gives up on a pending request after 30s.
    const request = repo.createRuntimeModelListRequest("rt_q");
    db!.run("UPDATE multiremi_runtime_model_list_requests SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 31_000).toISOString(),
      request.id,
    ]);

    const expired = repo.getRuntimeModelListRequest("rt_q", request.id);
    expect(expired?.status).toBe("timeout");
    expect(expired?.error).toBe("daemon did not respond within 30 seconds");
    expect(repo.claimRuntimeModelListRequest("rt_q")).toBeNull();
  });

  it("times out a running request past its own deadline", () => {
    const repo = createRepo();
    const request = repo.createRuntimeModelListRequest("rt_q");
    repo.claimRuntimeModelListRequest("rt_q");
    db!.run("UPDATE multiremi_runtime_model_list_requests SET run_started_at = ? WHERE id = ?", [
      new Date(Date.now() - 61_000).toISOString(),
      request.id,
    ]);

    const expired = repo.getRuntimeModelListRequest("rt_q", request.id);
    expect(expired?.status).toBe("timeout");
    expect(expired?.error).toBe("daemon did not finish within 60 seconds");
  });

  it("keeps each family's deadline separate", () => {
    const repo = createRepo();
    // 45s is past the model-list pending deadline (30s) but inside directory scan's (3min).
    const stale = new Date(Date.now() - 45_000).toISOString();
    const models = repo.createRuntimeModelListRequest("rt_q");
    const scan = repo.createRuntimeDirectoryScanRequest("rt_q");
    db!.run("UPDATE multiremi_runtime_model_list_requests SET created_at = ? WHERE id = ?", [stale, models.id]);
    db!.run("UPDATE multiremi_runtime_directory_scan_requests SET created_at = ? WHERE id = ?", [stale, scan.id]);

    expect(repo.getRuntimeModelListRequest("rt_q", models.id)?.status).toBe("timeout");
    expect(repo.getRuntimeDirectoryScanRequest("rt_q", scan.id)?.status).toBe("pending");
  });

  it("runs the command family through pending, running, and completed", () => {
    const repo = createRepo();
    const request = repo.createRuntimeCommandRequest("rt_q", {
      command: "printf ready",
      timeoutMs: 2_000,
      createdBy: "admin-user",
    });
    expect(request.status).toBe("pending");
    expect(request.createdBy).toBe("admin-user");

    expect(repo.claimRuntimeCommandRequest("rt_q")?.status).toBe("running");
    const completed = repo.reportRuntimeCommandResult("rt_q", request.id, {
      status: "completed",
      exitCode: 7,
      stdout: "ready",
      durationMs: 12,
    });
    expect(completed).toMatchObject({ status: "completed", exitCode: 7, stdout: "ready", durationMs: 12 });
    expect(completed.command).toBe("");
    expect(completed.args).toEqual([]);
    expect(completed.redactedCommand).toBe("printf ready");
  });

  it("expires pending and running command requests on their separate deadlines", () => {
    const repo = createRepo();
    const pending = repo.createRuntimeCommandRequest("rt_q", { command: "printf pending" });
    db!.run("UPDATE multiremi_runtime_command_requests SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 181_000).toISOString(),
      pending.id,
    ]);
    expect(repo.getRuntimeCommandRequest("rt_q", pending.id)).toMatchObject({
      status: "timeout",
      error: "daemon did not respond within 3 minutes",
      command: "",
      args: [],
      redactedCommand: "printf pending",
    });

    const running = repo.createRuntimeCommandRequest("rt_q", { command: "printf running" });
    repo.claimRuntimeCommandRequest("rt_q");
    db!.run("UPDATE multiremi_runtime_command_requests SET run_started_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_201_000).toISOString(),
      running.id,
    ]);
    expect(repo.getRuntimeCommandRequest("rt_q", running.id)).toMatchObject({
      status: "timeout",
      error: "daemon did not finish the command within 20 minutes",
      command: "",
      args: [],
      redactedCommand: "printf running",
    });
  });
});
