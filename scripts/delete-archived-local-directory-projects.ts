import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openMultiremiDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";

const PROJECT_IDS = ["prj_r1owd76u59zj", "prj_2iaep2zsnz25"] as const;
const execute = process.argv.includes("--execute");
const confirmArg = process.argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) ?? "";
const expectedConfirmation = [...PROJECT_IDS].sort().join(",");

if (execute && confirmArg.split(",").map((value) => value.trim()).filter(Boolean).sort().join(",") !== expectedConfirmation) {
  throw new Error(`execution requires --confirm=${PROJECT_IDS.join(",")}`);
}

const db = openMultiremiDatabase();
try {
  const audit = buildAudit(db);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  if (!execute) {
    process.stdout.write(`Dry run only. Re-run with --execute --confirm=${PROJECT_IDS.join(",")} after reviewing this output.\n`);
    process.exit(0);
  }
  if (audit.projects.length !== PROJECT_IDS.length || audit.projects.some((project) => !project.archived_at)) {
    throw new Error("refusing deletion: every allowlisted project must exist and be archived");
  }
  if (audit.externalProjectRefs.length) {
    throw new Error("refusing deletion: another project still references an allowlisted project");
  }

  const auditDir = resolve("artifacts", "project-deletion-audits");
  mkdirSync(auditDir, { recursive: true });
  const auditPath = resolve(auditDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });

  const remove = db.transaction(() => deleteGraph(db, audit.ids));
  const deleted = remove();
  process.stdout.write(`${JSON.stringify({ deleted, auditPath }, null, 2)}\n`);
} finally {
  db.close();
}

interface IdGraph {
  projects: string[];
  issues: string[];
  tasks: string[];
  docs: string[];
  issueSessions: string[];
  comments: string[];
  autopilots: string[];
  autopilotRuns: string[];
  autopilotTriggers: string[];
}

function buildAudit(db: SqlDatabase) {
  const ids = collectIds(db);
  const projects = selectByIds(db, "multiremi_projects", "id", ids.projects) as Array<Record<string, unknown>>;
  const externalProjectRefs = ids.projects.flatMap((projectId) => db.query(
    `SELECT id, project_id, resource_ref FROM multiremi_project_resources
     WHERE resource_type = 'project_ref' AND project_id NOT IN (${placeholders(ids.projects)}) AND resource_ref LIKE ?`,
  ).all(...ids.projects, `%${projectId}%`) as Array<Record<string, unknown>>);
  const counts = matchingCounts(db, ids, projects.length);
  return {
    mode: execute ? "execute" : "dry-run",
    generatedAt: new Date().toISOString(),
    database: process.env.MULTIREMI_DATABASE_URL ? "postgres" : "sqlite",
    physicalDirectoriesDeleted: false,
    projects,
    externalProjectRefs,
    ids,
    counts,
  };
}

function collectIds(db: SqlDatabase): IdGraph {
  const projects = [...PROJECT_IDS];
  const issues = idsFrom(db, "multiremi_issues", "project_id", projects);
  const tasks = expandTaskIds(db, idsFrom(db, "multiremi_tasks", "issue_id", issues));
  const docs = idsFrom(db, "multiremi_project_docs", "project_id", projects);
  const issueSessions = idsFrom(db, "multiremi_issue_sessions", "issue_id", issues);
  const comments = idsFrom(db, "multiremi_issue_comments", "issue_id", issues);
  const autopilots = idsFrom(db, "multiremi_autopilots", "project_id", projects);
  const autopilotRuns = unique([
    ...idsFrom(db, "multiremi_autopilot_runs", "autopilot_id", autopilots),
    ...idsFrom(db, "multiremi_autopilot_runs", "issue_id", issues),
    ...idsFrom(db, "multiremi_autopilot_runs", "task_id", tasks),
  ]);
  const autopilotTriggers = idsFrom(db, "multiremi_autopilot_triggers", "autopilot_id", autopilots);
  return { projects, issues, tasks, docs, issueSessions, comments, autopilots, autopilotRuns, autopilotTriggers };
}

function matchingCounts(db: SqlDatabase, ids: IdGraph, matchedProjectCount: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tableNames(db)) {
    const predicate = tablePredicate(db, table, ids);
    if (!predicate) continue;
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate.sql}`).get(...predicate.params) as { count?: unknown } | null;
    const count = Number(row?.count ?? 0);
    if (count) counts[table] = count;
  }
  if (matchedProjectCount) counts.multiremi_projects = matchedProjectCount;
  return counts;
}

function deleteGraph(db: SqlDatabase, ids: IdGraph): Record<string, number> {
  const deleted: Record<string, number> = {};
  const roots = new Set(["multiremi_projects", "multiremi_issues", "multiremi_tasks", "multiremi_project_docs", "multiremi_issue_sessions", "multiremi_issue_comments", "multiremi_autopilots", "multiremi_autopilot_runs", "multiremi_autopilot_triggers"]);
  const tables = tableNames(db).filter((table) => !roots.has(table));
  tables.push("multiremi_autopilot_triggers", "multiremi_autopilot_runs", "multiremi_autopilots", "multiremi_issue_comments", "multiremi_issue_sessions", "multiremi_project_docs", "multiremi_tasks", "multiremi_issues");
  for (const table of tables) {
    const predicate = tablePredicate(db, table, ids);
    if (!predicate) continue;
    const result = db.query(`DELETE FROM ${table} WHERE ${predicate.sql}`).run(...predicate.params);
    if (result.changes) deleted[table] = result.changes;
  }
  const result = db.query(`DELETE FROM multiremi_projects WHERE id IN (${placeholders(ids.projects)})`).run(...ids.projects);
  deleted.multiremi_projects = result.changes;
  return deleted;
}

function tablePredicate(db: SqlDatabase, table: string, ids: IdGraph): { sql: string; params: string[] } | null {
  const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  const candidates: Array<[string, string[]]> = [
    ["project_id", ids.projects], ["issue_id", ids.issues], ["source_issue_id", ids.issues], ["depends_on_issue_id", ids.issues],
    ["task_id", ids.tasks], ["source_task_id", ids.tasks], ["parent_task_id", ids.tasks],
    ["doc_id", ids.docs], ["project_doc_id", ids.docs], ["issue_session_id", ids.issueSessions], ["source_session_id", ids.issueSessions],
    ["comment_id", ids.comments], ["autopilot_id", ids.autopilots], ["autopilot_run_id", ids.autopilotRuns], ["trigger_id", ids.autopilotTriggers],
  ];
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [column, values] of candidates) {
    if (!columns.has(column) || !values.length) continue;
    clauses.push(`${column} IN (${placeholders(values)})`);
    params.push(...values);
  }
  if (["multiremi_session_participants", "multiremi_session_events", "multiremi_session_agent_lanes"].includes(table) && columns.has("session_id") && ids.issueSessions.length) {
    clauses.push(`session_id IN (${placeholders(ids.issueSessions)})`);
    params.push(...ids.issueSessions);
  }
  if (table === "multiremi_pinned_items" && columns.has("item_type") && columns.has("item_id")) {
    clauses.push(`(item_type = 'project' AND item_id IN (${placeholders(ids.projects)}))`);
    params.push(...ids.projects);
  }
  return clauses.length ? { sql: clauses.map((clause) => `(${clause})`).join(" OR "), params } : null;
}

function tableNames(db: SqlDatabase): string[] {
  return (db.query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string; type: string }>)
    .filter((entry) => entry.type === "table" && /^multiremi_[a-z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name);
}

function expandTaskIds(db: SqlDatabase, initial: string[]): string[] {
  const ids = new Set(initial);
  let changed = true;
  while (changed && ids.size) {
    changed = false;
    for (const row of db.query(`SELECT id FROM multiremi_tasks WHERE parent_task_id IN (${placeholders([...ids])})`).all(...ids) as Array<{ id: string }>) {
      if (!ids.has(row.id)) { ids.add(row.id); changed = true; }
    }
  }
  return [...ids];
}

function idsFrom(db: SqlDatabase, table: string, column: string, values: string[]): string[] {
  if (!values.length) return [];
  return (db.query(`SELECT id FROM ${table} WHERE ${column} IN (${placeholders(values)})`).all(...values) as Array<{ id: string }>).map((row) => row.id);
}

function selectByIds(db: SqlDatabase, table: string, column: string, values: string[]): unknown[] {
  return values.length ? db.query(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders(values)})`).all(...values) : [];
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
