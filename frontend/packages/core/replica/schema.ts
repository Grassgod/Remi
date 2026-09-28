/**
 * The replica's SQLite schema (MUL-403 C7 §4).
 *
 * One database file per `(user_id, workspace_id)`, path
 * `remi-replica/<user>/<ws>.sqlite3`, so two workspaces of the same user never
 * share a file and two users of the same workspace never share a file either.
 * Six tables, and each one exists because a specific reader needs it:
 *
 * | table | why it is a table and not a column |
 * |---|---|
 * | `entries` | the rows the window renders, keyed by `(session_id, seq)` |
 * | `revision_watermarks` | highest accepted revision, retained after deletion/hiding |
 * | `ranges` | a deep-link window is sparse, so coverage is many ranges, not one `head` |
 * | `heads` | `head_seq` + `log_version` is the freshness token, and the resume cursor |
 * | `row_heights` | measured heights, keyed per variant and width bucket |
 * | `meta` | schema version and `user_id`, i.e. the two cleanup triggers |
 *
 * `heads.head_seq` is nullable on purpose: `NULL` means "an ack has arrived but no
 * row has been written yet", which is different from seq 0 (a real seq for an
 * empty session) and from having no row at all. Coercing it to 0 is what makes a
 * stale window look fresh, because the next comparison is against the server's
 * own head.
 *
 * `ranges` is what makes `head` meaningful: `head` is the newest contiguous run,
 * not the newest row, so the table stores coverage explicitly instead of the
 * reader inferring it from the rows it happens to see (a deleted hidden marker
 * leaves a hole in `entries` without leaving one in reality).
 */

/**
 * Bump on any change to the statements below.
 *
 * A mismatch is not migrated: the leader deletes the whole database and
 * re-subscribes, which is correct because the replica is a cache and a migration
 * would be a second implementation of the log's own schema evolution (plan 3/6
 * §1.6 lists schema upgrade among the full-clear triggers).
 */
export const REPLICA_SCHEMA_VERSION = 2;

/** `meta` keys. `user_id` is a cleanup trigger, not bookkeeping. */
export const META_USER_ID = "user_id";
export const META_SCHEMA_VERSION = "schema_version";
export const META_WORKSPACE_ID = "workspace_id";

export const REPLICA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  session_id     TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  id             TEXT    NOT NULL,
  revision       INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  body_md        TEXT    NOT NULL,
  body_html      TEXT,
  render_version TEXT,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS ranges (
  session_id TEXT    NOT NULL,
  from_seq   INTEGER NOT NULL,
  to_seq     INTEGER NOT NULL,
  PRIMARY KEY (session_id, from_seq)
);

CREATE TABLE IF NOT EXISTS revision_watermarks (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  revision   INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS heads (
  session_id  TEXT    PRIMARY KEY,
  head_seq    INTEGER,
  log_version INTEGER,
  synced_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS row_heights (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  height     REAL    NOT NULL,
  PRIMARY KEY (session_id, seq, key)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_session_seq ON entries (session_id, seq);
CREATE INDEX IF NOT EXISTS ranges_session ON ranges (session_id, from_seq);
`.trim();

/** Every statement the replica runs, so the Worker and the tests share one spelling. */
export const SQL = {
  begin: "BEGIN IMMEDIATE",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  selectMeta: "SELECT v FROM meta WHERE k = ?",
  upsertMeta: "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  insertEntry: `INSERT INTO entries (session_id, seq, id, revision, kind, body_md, body_html, render_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, seq) DO UPDATE SET
       id = excluded.id,
       revision = excluded.revision,
       kind = excluded.kind,
       body_md = excluded.body_md,
       body_html = excluded.body_html,
       render_version = excluded.render_version`,
  deleteEntry: "DELETE FROM entries WHERE session_id = ? AND seq = ?",
  selectWindow: `SELECT session_id, seq, id, revision, kind, body_md, body_html, render_version
     FROM entries WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC`,
  countEntries: "SELECT COUNT(*) AS n FROM entries WHERE session_id = ?",
  selectRevisionWatermarks: "SELECT seq, revision FROM revision_watermarks WHERE session_id = ?",
  upsertRevisionWatermark: `INSERT INTO revision_watermarks (session_id, seq, revision) VALUES (?, ?, ?)
     ON CONFLICT(session_id, seq) DO UPDATE SET revision = MAX(revision_watermarks.revision, excluded.revision)`,
  deleteSessionEntries: "DELETE FROM entries WHERE session_id = ?",
  deleteSessionRevisionWatermarks: "DELETE FROM revision_watermarks WHERE session_id = ?",
  deleteSessionHead: "DELETE FROM heads WHERE session_id = ?",
  deleteSessionHeights: "DELETE FROM row_heights WHERE session_id = ?",
  selectRanges: "SELECT from_seq, to_seq FROM ranges WHERE session_id = ? ORDER BY from_seq ASC",
  insertRange: "INSERT OR REPLACE INTO ranges (session_id, from_seq, to_seq) VALUES (?, ?, ?)",
  deleteRanges: "DELETE FROM ranges WHERE session_id = ?",
  selectHead: "SELECT head_seq, log_version FROM heads WHERE session_id = ?",
  upsertHead: `INSERT INTO heads (session_id, head_seq, log_version, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       head_seq = excluded.head_seq,
       log_version = excluded.log_version,
       synced_at = excluded.synced_at`,
  selectRowHeight: "SELECT height FROM row_heights WHERE session_id = ? AND seq = ? AND key = ?",
  upsertRowHeight: `INSERT INTO row_heights (session_id, seq, key, height) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, seq, key) DO UPDATE SET height = excluded.height`,
  selectAllRowHeights: "SELECT seq, key, height FROM row_heights WHERE session_id = ?",
  /**
   * Whole-database wipes. `deleteAll*` is not `deleteSession*` for every session
   * the caller happens to know: the plan's trigger is 整库清除, and a fresh
   * leader taking over after a user switch has no idea which sessions the
   * previous user left behind. Leaving those rows is precisely the leak the
   * `user_id` check exists to prevent.
   */
  deleteAllEntries: "DELETE FROM entries",
  deleteAllRevisionWatermarks: "DELETE FROM revision_watermarks",
  deleteAllRanges: "DELETE FROM ranges",
  deleteAllHeads: "DELETE FROM heads",
  deleteAllHeights: "DELETE FROM row_heights",
  deleteAllMeta: "DELETE FROM meta",
} as const;
