import { Database } from "bun:sqlite";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { MultiremiStore } from "@multiremi/store.js";

export type ChildMutation = "create" | "attach" | "reopen_done" | "reopen_cancelled" | "assign_done" | "assign_cancelled";
export interface RaceOperation {
  type: "run";
  role: "parent" | "child";
  parentId: string;
  childId: string;
  ownerId: string;
  mutation: ChildMutation;
  path: "api" | "scm";
  status: "done" | "in_review";
  connectionId: string;
  number: number;
  pause: boolean;
  control: SharedArrayBuffer;
}
export interface RaceResult {
  phase: "done";
  error: string | null;
  parentStatus: string | null;
  maxDepth: number;
  eventsInTransaction: number;
}

let database: SqlDatabase;
let store: MultiremiStore;
let operation: RaceOperation | null = null;
let paused = false;
let eventsInTransaction = 0;

function barrier(): void {
  if (!operation?.pause || paused) return;
  paused = true;
  const control = new Int32Array(operation.control);
  Atomics.store(control, 0, 1);
  if (Atomics.wait(control, 1, 0, 15_000) === "timed-out") throw new Error("race barrier timed out");
}

const hasChildren = IssuesRepo.prototype.hasChildIssues;
IssuesRepo.prototype.hasChildIssues = function (id) {
  const result = hasChildren.call(this, id);
  if (operation?.role === "parent" && id === operation.parentId && !result) barrier();
  return result;
};
const countChildren = IssuesRepo.prototype.countOpenChildIssues;
IssuesRepo.prototype.countOpenChildIssues = function (id) {
  const result = countChildren.call(this, id);
  if (operation?.role === "parent" && id === operation.parentId && operation.status !== "done") barrier();
  return result;
};
const finalSummary = IssuesRepo.prototype.finalSummaryAfterLastChild;
IssuesRepo.prototype.finalSummaryAfterLastChild = function (id, options) {
  const result = finalSummary.call(this, id, options);
  if (operation?.role === "parent" && id === operation.parentId) barrier();
  return result;
};

self.onmessage = (event: MessageEvent<
  | { type: "init"; dialect: "sqlite" | "postgres"; location: string; applicationName: string }
  | { type: "close" }
  | RaceOperation
>) => {
  const input = event.data;
  if (input.type === "init") {
    if (input.dialect === "postgres") {
      const url = new URL(input.location);
      url.searchParams.set("application_name", input.applicationName);
      database = new PostgresSyncDatabase(url.toString());
      database.exec("SET lock_timeout = '5s'; SET statement_timeout = '10s'");
    } else {
      database = new Database(input.location);
      database.exec("PRAGMA busy_timeout = 0");
    }
    store = new MultiremiStore(database);
    const run = database.run.bind(database);
    database.run = (sql, ...params) => {
      const result = run(sql, ...params);
      if (operation?.role === "child"
        && (/INSERT INTO multiremi_issues\s*\(/.test(sql)
          || /UPDATE multiremi_issues SET\s+title =/.test(sql)
          || /UPDATE multiremi_issues\s+SET assignee_type = .*status =/s.test(sql))) barrier();
      return result;
    };
    store.onWorkspaceEvent(() => {
      if (database.inTransaction) eventsInTransaction += 1;
    });
    self.postMessage({ phase: "ready" });
    return;
  }
  if (input.type === "close") {
    database.close();
    self.postMessage({ phase: "closed" });
    return;
  }
  operation = input;
  paused = false;
  eventsInTransaction = 0;
  if (database instanceof PostgresSyncDatabase) database.resetTransactionDepthStats();
  let error: string | null = null;
  try {
    if (input.role === "child") {
      if (input.mutation === "create") {
        store.createIssue({ id: input.childId, title: "Concurrent child", parentIssueId: input.parentId, status: "in_progress" });
      } else if (input.mutation.startsWith("assign_")) {
        store.assignIssue(input.childId, { assigneeType: "agent", assigneeId: input.ownerId });
      } else {
        store.updateIssue(input.childId, input.mutation === "attach"
          ? { parent_issue_id: input.parentId }
          : { status: "in_progress" });
      }
    } else if (input.path === "api") {
      store.updateIssue(input.parentId, { status: input.status, actorType: "agent", actorId: input.ownerId });
    } else {
      store.recordScmCanonicalEvent({
        workspaceId: "local", connectionId: input.connectionId, repositoryId: "repo_mul471",
        type: "change.merged", subjectType: "change_request", subjectId: String(input.number),
        logicalKey: `change.merged:${input.number}`, fidelity: "exact",
        payload: { number: input.number, branch: "main", mergeSha: `sha-${input.number}` },
        evidence: { source: "poll", dedupeKey: `poll:${input.number}` },
      });
      const effect = database.query("SELECT last_error FROM multiremi_scm_effects WHERE issue_id = ?").get(input.parentId);
      error = effect?.last_error ?? null;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  self.postMessage({
    phase: "done", error, parentStatus: store.getIssue(input.parentId)?.status ?? null,
    maxDepth: database.maxTransactionDepth ?? 1, eventsInTransaction,
  } satisfies RaceResult);
  operation = null;
};
