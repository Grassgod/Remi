import type { StorageReport, StorageSubjectRef, SubjectSnapshot } from "@multiremi/contracts/storage.js";
import { nowIso } from "@multiremi/ids.js";
import { parseJson, toJson } from "@multiremi/store/helpers.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type { IssueWorkspacesRepo } from "@multiremi/store/repos/issue-workspaces-repo.js";

type Row = Record<string, unknown>;

export interface SubjectReclaimedInput {
  subject: StorageSubjectRef;
  snapshot: SubjectSnapshot | null;
  unsavedWork: boolean;
}

export interface DaemonStorageReportRecord {
  daemonId: string;
  runtimeId: string;
  report: StorageReport;
  reportedAt: string;
}

/** Runtime ids that belong to the daemon serving `runtimeId`, as a sub-select with two parameters. */
const DAEMON_RUNTIMES_SQL =
  "(SELECT id FROM multiremi_runtimes WHERE id = ? OR (daemon_id IS NOT NULL AND daemon_id = ?))";

/**
 * What the daemons tell the control plane about their disks: the per-daemon
 * storage report and the notice that a subject's workspace was reclaimed.
 */
export class StorageRepo {
  constructor(
    private readonly ctx: StoreContext,
    private readonly issueWorkspaces: IssueWorkspacesRepo,
  ) {}

  /**
   * A daemon deleted a subject's workspace. The Issue's workspace record keeps the
   * snapshot, and every native session the subject held on this daemon is reset so
   * the next execution starts a new generation instead of resuming a deleted home.
   */
  reportSubjectReclaimed(runtimeId: string, input: SubjectReclaimedInput): void {
    const runtime = this.ctx.runtimes().getRuntimeLite(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    const daemonParams = [runtime.id, runtime.daemonId ?? runtime.id];
    const resetLanes = (sessionIds: { sql: string; params: unknown[] }) => this.ctx.db.run(
      `UPDATE multiremi_session_lanes
       SET provider_session_id = NULL,
           runtime_id = NULL,
           provider = NULL,
           execution_fingerprint = NULL,
           work_dir = NULL,
           provider_cursor_seq = 0,
           parent_cursor_seq = 0,
           generation = generation + 1,
           last_attempt_id = NULL,
           updated_at = ?
       WHERE reader_type = 'agent'
         AND runtime_id IN ${DAEMON_RUNTIMES_SQL}
         AND session_id IN ${sessionIds.sql}`,
      [nowIso(), ...daemonParams, ...sessionIds.params],
    );
    this.ctx.db.transaction(() => {
      if (input.subject.kind === "issue") {
        this.issueWorkspaces.markCleaned({
          issueId: input.subject.id,
          runtimeId,
          snapshot: input.snapshot,
          unsavedWork: input.unsavedWork,
        });
        resetLanes({
          sql: "(SELECT id FROM multiremi_issue_sessions WHERE issue_id = ?)",
          params: [input.subject.id],
        });
      } else if (input.subject.kind === "chat") {
        this.ctx.db.run(
          `UPDATE multiremi_chat_sessions
           SET session_id = NULL,
               work_dir = NULL,
               session_runtime_id = NULL,
               session_provider = NULL,
               session_execution_fingerprint = NULL,
               updated_at = ?
           WHERE id = ? AND session_runtime_id IN ${DAEMON_RUNTIMES_SQL}`,
          [nowIso(), input.subject.id, ...daemonParams],
        );
        resetLanes({ sql: "(?)", params: [input.subject.id] });
      }
    })();
  }

  /**
   * A daemon serving runtimes of several workspaces keeps one report per workspace. A report
   * without category sizes (its daemon has not finished a measurement yet, e.g. after losing its
   * cache) keeps the last measurement instead of replacing it with "not measured".
   */
  saveDaemonStorageReport(daemonId: string, runtimeId: string, report: StorageReport): void {
    const runtime = this.ctx.runtimes().getRuntimeLite(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    const workspaceId = runtime.workspaceId ?? "local";
    if (report.bytes === null) {
      const previous = this.ctx.db.query(
        "SELECT report FROM multiremi_daemon_storage_reports WHERE workspace_id = ? AND daemon_id = ?",
      ).get(workspaceId, daemonId) as Row | null;
      const last = parseJson<StorageReport | null>(previous?.report, null);
      report = { ...report, bytes: last?.bytes ?? null, bytes_measured_at: last?.bytes_measured_at ?? null };
    }
    this.ctx.db.run(
      `INSERT INTO multiremi_daemon_storage_reports (workspace_id, daemon_id, runtime_id, report, reported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, daemon_id) DO UPDATE SET
         runtime_id = excluded.runtime_id, report = excluded.report, reported_at = excluded.reported_at`,
      [workspaceId, daemonId, runtimeId, toJson(report), nowIso()],
    );
  }

  /** The latest report of each daemon that has sent one for the workspace. */
  listDaemonStorageReports(workspaceId: string, daemonIds: readonly string[]): DaemonStorageReportRecord[] {
    if (!daemonIds.length) return [];
    const rows = this.ctx.db.query(
      `SELECT daemon_id, runtime_id, report, reported_at FROM multiremi_daemon_storage_reports
       WHERE workspace_id = ? AND daemon_id IN (${daemonIds.map(() => "?").join(",")})`,
    ).all(workspaceId, ...daemonIds) as Row[];
    return rows.flatMap((row) => {
      const report = parseJson<StorageReport | null>(row.report, null);
      return report
        ? [{
          daemonId: String(row.daemon_id),
          runtimeId: String(row.runtime_id),
          report,
          reportedAt: String(row.reported_at),
        }]
        : [];
    });
  }
}
