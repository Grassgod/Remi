// Sibling test for packages/server/src/store/migrations.ts — the extracted schema
// module that SPLIT-PLAN §1.2 calls for (`MultiremiStore.migrate()` is a one-line
// call into it). Covers a fresh database, idempotency across restarts, and the
// three legacy migrations that MUST run on every startup (8f20d1c8: losing them
// breaks old-database upgrades).
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

let db: Database | null = null;

function freshDb(): Database {
  db = new Database(":memory:");
  return db;
}

function migrate(database: Database): void {
  runMigrations(database as unknown as SqlDatabase);
}

function tableNames(database: Database): string[] {
  return (database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columnNames(database: Database, table: string): string[] {
  return (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("store migrations", () => {
  it("creates the schema on a fresh database", () => {
    const database = freshDb();
    migrate(database);

    const tables = tableNames(database);
    for (const table of [
      "multiremi_agents",
      "multiremi_issues",
      "multiremi_issue_activity",
      "multiremi_issue_subscribers",
      "multiremi_inbox_items",
      "multiremi_notification_channels",
      "multiremi_notification_deliveries",
      "multiremi_tasks",
      "multiremi_task_messages",
      "multiremi_workspaces",
      "multiremi_workspace_members",
      "multiremi_runtimes",
      "multiremi_autopilots",
      "multiremi_system_events",
      "multiremi_scm_connections",
      "multiremi_scm_repository_bindings",
      "multiremi_scm_sync_cursors",
      "multiremi_scm_entity_snapshots",
      "multiremi_scm_change_requests",
      "multiremi_scm_issue_links",
      "multiremi_scm_effects",
      "multiremi_scm_events",
      "multiremi_scm_event_evidence",
      "multiremi_scm_event_deliveries",
      "multiremi_projects",
      "multiremi_chat_sessions",
      "multiremi_feedback",
      "multiremi_access_tokens",
      "multiremi_session_archives",
      "multiremi_schema_migrations",
    ]) {
      expect(tables).toContain(table);
    }
    expect(tables.some((name) => name.startsWith("multica_"))).toBe(false);
    expect(tables).not.toContain("multiremi_github_settings");
    expect(tables).not.toContain("multiremi_github_pull_requests");
    expect(columnNames(database, "multiremi_access_tokens")).toContain("purpose");
    expect(columnNames(database, "multiremi_tasks")).toContain("task_kind");
    expect(columnNames(database, "multiremi_autopilots")).toEqual(expect.arrayContaining([
      "session_policy", "workspace_policy",
    ]));
    expect(columnNames(database, "multiremi_autopilot_triggers")).toContain("event_config");
    expect(columnNames(database, "multiremi_autopilot_runs")).toEqual(expect.arrayContaining([
      "trigger_id", "event_id", "issue_session_id", "repository_id", "dedupe_key",
    ]));
    expect(columnNames(database, "multiremi_issues")).toEqual(expect.arrayContaining([
      "issue_kind", "source_issue_id", "lifecycle_state", "completed_at", "archived_at",
    ]));
    expect(columnNames(database, "multiremi_issue_workspaces")).toEqual(expect.arrayContaining([
      "cleaned_archive_id", "cleaned_archive_source_revision", "cleaned_archive_sha256",
    ]));
    expect(columnNames(database, "multiremi_agent_plugin_bindings")).not.toContain("task_kind");
    expect(columnNames(database, "multiremi_project_docs")).toEqual(expect.arrayContaining([
      "storage_backend", "content_uri", "content_sha256", "sync_status", "sync_error", "snapshot_oid",
    ]));
    expect(columnNames(database, "multiremi_project_doc_revisions")).toEqual(expect.arrayContaining([
      "content_uri", "content_sha256", "snapshot_oid",
    ]));
    expect(columnNames(database, "multiremi_daemon_retirements")).toContain("ssh_mesh_rekey_operation_id");
    expect(columnNames(database, "multiremi_workspace_ssh_mesh")).toContain("active_operation_id");
    expect(columnNames(database, "multiremi_daemon_ssh_mesh_states")).toEqual(expect.arrayContaining([
      "node_kind", "name",
    ]));
    expect(columnNames(database, "multiremi_session_archives")).toEqual(expect.arrayContaining([
      "source_revision", "sha256", "relative_path", "status", "uploaded_size_bytes",
    ]));
    expect(columnNames(database, "multiremi_notification_deliveries")).toContain("leased_until");
  });

  it("adds the notification delivery lease to a pre-lease table", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_notification_deliveries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        inbox_item_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_kind TEXT NOT NULL,
        target_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt_at TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL
      );
    `);

    migrate(database);

    expect(columnNames(database, "multiremi_notification_deliveries")).toContain("leased_until");
    expect(database.query(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_multiremi_notification_deliveries_pending'`,
    ).get()).toEqual({ name: "idx_multiremi_notification_deliveries_pending" });
  });

  it("migrates legacy GitHub PR projections and settings without dual-writing", () => {
    const database = freshDb();
    migrate(database);
    const now = "2026-08-22T00:00:00.000Z";
    database.exec(`
      CREATE TABLE multiremi_github_settings (
        workspace_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, pr_sidebar INTEGER NOT NULL,
        co_author INTEGER NOT NULL, auto_link_prs INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE multiremi_github_pull_requests (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, issue_id TEXT,
        repo_owner TEXT NOT NULL, repo_name TEXT NOT NULL, number INTEGER NOT NULL,
        title TEXT NOT NULL, state TEXT NOT NULL, html_url TEXT NOT NULL, branch TEXT,
        author_login TEXT, author_avatar_url TEXT, merged_at TEXT, closed_at TEXT,
        pr_created_at TEXT NOT NULL, pr_updated_at TEXT NOT NULL, mergeable_state TEXT,
        checks_conclusion TEXT, checks_passed INTEGER NOT NULL DEFAULT 0,
        checks_failed INTEGER NOT NULL DEFAULT 0, checks_pending INTEGER NOT NULL DEFAULT 0,
        additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    database.run(
      `INSERT INTO multiremi_workspaces (
        id, name, slug, description, context, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES ('local', 'Local', 'local', NULL, NULL, '{}', '[]', 'MUL', ?, ?)`,
      [now, now],
    );
    database.run(
      `INSERT INTO multiremi_issues (
        id, issue_number, issue_key, title, status, workspace_id, created_at, updated_at
      ) VALUES ('iss_legacy', 1, 'MUL-1', 'Legacy issue', 'todo', 'local', ?, ?)`,
      [now, now],
    );
    database.run(
      `INSERT INTO multiremi_scm_connections (
        id, workspace_id, name, provider, mode, base_url, api_base_url, enabled,
        poll_interval_seconds, created_at, updated_at
      ) VALUES ('scm_legacy', 'local', 'GitHub', 'github', 'poll',
        'https://github.com', 'https://api.github.com', 1, 60, ?, ?)`,
      [now, now],
    );
    database.run(
      `INSERT INTO multiremi_scm_repository_bindings (
        id, workspace_id, connection_id, repository_id, repository_url, owner, name,
        enabled, created_at, updated_at
      ) VALUES ('srb_legacy', 'local', 'scm_legacy', 'repo_legacy',
        'git@github.com:acme/widgets.git', 'acme', 'widgets', 1, ?, ?)`,
      [now, now],
    );
    database.run(
      `INSERT INTO multiremi_github_settings (
        workspace_id, enabled, pr_sidebar, co_author, auto_link_prs, updated_at
      ) VALUES ('local', 1, 0, 0, 1, ?)`,
      [now],
    );
    database.run(
      `INSERT INTO multiremi_github_pull_requests (
        id, workspace_id, issue_id, repo_owner, repo_name, number, title, state,
        html_url, branch, pr_created_at, pr_updated_at, created_at, updated_at
      ) VALUES ('ghp_legacy', 'local', 'iss_legacy', 'acme', 'widgets', 7,
        'MUL-1 migrated', 'open', 'https://github.com/acme/widgets/pull/7',
        'feature/migrate', ?, ?, ?, ?)`,
      [now, now, now, now],
    );

    migrate(database);
    expect(database.query(
      "SELECT provider, number, source_branch FROM multiremi_scm_change_requests WHERE repository_id = 'repo_legacy'",
    ).get()).toEqual({ provider: "github", number: 7, source_branch: "feature/migrate" });
    expect(database.query(
      "SELECT issue_id, source, active FROM multiremi_scm_issue_links WHERE issue_id = 'iss_legacy'",
    ).get()).toEqual({ issue_id: "iss_legacy", source: "legacy", active: 1 });
    const settings = JSON.parse(String((database.query(
      "SELECT settings FROM multiremi_workspaces WHERE id = 'local'",
    ).get() as { settings: string }).settings));
    expect(settings).toMatchObject({
      scm_change_sidebar_enabled: false,
      scm_auto_link_enabled: true,
      scm_complete_issue_on_merge_enabled: false,
      co_authored_by_enabled: false,
    });

    migrate(database);
    expect(database.query("SELECT COUNT(*) AS count FROM multiremi_scm_change_requests").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM multiremi_scm_issue_links").get()).toEqual({ count: 1 });
  });

  it("upgrades legacy SSH Mesh daemon state rows as runtime nodes", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_daemon_ssh_mesh_states (
        workspace_id TEXT NOT NULL,
        daemon_id TEXT NOT NULL,
        runtime_id TEXT,
        protocol_version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'setup_required',
        key_version INTEGER,
        config_revision TEXT,
        ssh_user TEXT,
        hostname TEXT,
        ssh_port INTEGER NOT NULL DEFAULT 22,
        addresses TEXT NOT NULL DEFAULT '[]',
        host_keys TEXT NOT NULL DEFAULT '[]',
        public_key_installed INTEGER NOT NULL DEFAULT 0,
        config_installed INTEGER NOT NULL DEFAULT 0,
        peer_tests TEXT NOT NULL DEFAULT '[]',
        probe_revision INTEGER NOT NULL DEFAULT 0,
        desired_probe_revision INTEGER NOT NULL DEFAULT 0,
        probe_target_daemon_ids TEXT NOT NULL DEFAULT '[]',
        last_error_code TEXT,
        last_error TEXT,
        last_reported_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, daemon_id)
      );
      INSERT INTO multiremi_daemon_ssh_mesh_states (
        workspace_id, daemon_id, created_at, updated_at
      ) VALUES (
        'local', 'legacy-daemon', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);

    migrate(database);

    expect(database.query(
      "SELECT daemon_id, node_kind, name FROM multiremi_daemon_ssh_mesh_states WHERE daemon_id = 'legacy-daemon'",
    ).get()).toEqual({ daemon_id: "legacy-daemon", node_kind: "runtime", name: null });
  });

  it("classifies legacy access tokens by their actual purpose", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_access_tokens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        user_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'pat',
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    const insert = database.prepare(
      "INSERT INTO multiremi_access_tokens (id, name, type, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const createdAt = "2026-01-01T00:00:00.000Z";
    insert.run("pat_personal", "My CLI", "pat", "hash-1", "mul_personal", createdAt);
    insert.run("pat_login", "Login for owner@example.com", "pat", "hash-2", "mul_login", createdAt);
    insert.run("pat_setup", "Remi daemon 2026-01-01", "pat", "hash-3", "mul_setup", createdAt);
    insert.run("daemon", "Laptop", "daemon", "hash-4", "mdt_daemon", createdAt);

    migrate(database);

    const rows = database.query(
      "SELECT id, purpose FROM multiremi_access_tokens ORDER BY id",
    ).all() as Array<{ id: string; purpose: string }>;
    expect(rows).toEqual([
      { id: "daemon", purpose: "daemon" },
      { id: "pat_login", purpose: "session" },
      { id: "pat_personal", purpose: "personal" },
      { id: "pat_setup", purpose: "cli" },
    ]);

    database.run("UPDATE multiremi_access_tokens SET purpose = 'personal' WHERE id = 'pat_login'");
    migrate(database);
    expect(database.query(
      "SELECT purpose FROM multiremi_access_tokens WHERE id = 'pat_login'",
    ).get()).toEqual({ purpose: "personal" });
  });

  it("is idempotent across restarts and preserves rows", () => {
    const database = freshDb();
    migrate(database);
    const first = tableNames(database);
    database.run(
      "INSERT INTO multiremi_agents (id, name, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["agt_keep", "Keep me", "claude", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );

    migrate(database);
    migrate(database);

    expect(tableNames(database)).toEqual(first);
    const row = database.query("SELECT name FROM multiremi_agents WHERE id = ?").get("agt_keep") as { name?: string } | null;
    expect(row?.name).toBe("Keep me");
  });

  it("backfills completed_at for legacy terminal issues", () => {
    const database = freshDb();
    migrate(database);
    database.exec(`
      DROP INDEX idx_multiremi_issues_archive;
      ALTER TABLE multiremi_issues DROP COLUMN archived_at;
      ALTER TABLE multiremi_issues DROP COLUMN completed_at;
    `);
    database.run(
      `INSERT INTO multiremi_issues (
         id, title, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        "iss_legacy_done",
        "Legacy done",
        "done",
        "2026-08-01T00:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
      ],
    );
    database.run(
      `INSERT INTO multiremi_issues (
         id, title, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        "iss_legacy_active",
        "Legacy active",
        "in_progress",
        "2026-08-01T00:00:00.000Z",
        "2026-08-05T12:00:00.000Z",
      ],
    );

    migrate(database);

    expect(database.query(
      "SELECT id, completed_at FROM multiremi_issues WHERE id LIKE 'iss_legacy_%' ORDER BY id",
    ).all()).toEqual([
      { id: "iss_legacy_active", completed_at: null },
      { id: "iss_legacy_done", completed_at: "2026-08-04T12:00:00.000Z" },
    ]);
  });

  it("backfills each sole provider origin as the default and binds matching imported repositories", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        context TEXT,
        settings TEXT NOT NULL DEFAULT '{}',
        repos TEXT NOT NULL DEFAULT '[]',
        issue_prefix TEXT NOT NULL DEFAULT 'MUL',
        env TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE multiremi_scm_connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_base_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
        access_token_encrypted TEXT,
        access_token_hint TEXT,
        webhook_secret_encrypted TEXT,
        webhook_secret_hint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, provider, name)
      );
      CREATE TABLE multiremi_scm_repository_bindings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        external_id TEXT,
        owner TEXT,
        name TEXT NOT NULL,
        default_branch TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, repository_id),
        UNIQUE(connection_id, repository_id)
      );
    `);
    const timestamp = "2026-08-20T00:00:00.000Z";
    database.run(
      `INSERT INTO multiremi_workspaces (id, name, slug, repos, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "local",
        "Local",
        "local",
        JSON.stringify([
          { id: "repo_bound", name: "bound", url: "git@github.com:acme/bound.git", source: "github", default_branch: "main" },
          { id: "repo_missing", name: "missing", url: "https://github.com/acme/missing.git", source: "github", default_branch: "trunk" },
          { id: "repo_enterprise", name: "enterprise", url: "https://github.acme.test/acme/enterprise.git", source: "github" },
          { id: "repo_codebase", name: "internal", url: "git@code.byted.org:acme/internal.git", source: "codebase" },
        ]),
        timestamp,
        timestamp,
      ],
    );
    database.run(
      `INSERT INTO multiremi_scm_connections (
        id, workspace_id, name, provider, mode, base_url, api_base_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["scm_github", "local", "GitHub", "github", "poll", "https://github.com", "https://api.github.com", timestamp, timestamp],
    );
    database.run(
      `INSERT INTO multiremi_scm_connections (
        id, workspace_id, name, provider, mode, base_url, api_base_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "scm_github_enterprise",
        "local",
        "GitHub Enterprise",
        "github",
        "poll",
        "https://github.acme.test/organization/path",
        "https://github.acme.test/api/v3",
        timestamp,
        timestamp,
      ],
    );
    for (const [id, name] of [["scm_codebase_one", "Codebase one"], ["scm_codebase_two", "Codebase two"]]) {
      database.run(
        `INSERT INTO multiremi_scm_connections (
          id, workspace_id, name, provider, mode, base_url, api_base_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, "local", name, "codebase", "poll", "https://code.byted.org", "https://codebase-api.byted.org/v2", timestamp, timestamp],
      );
    }
    database.run(
      `INSERT INTO multiremi_scm_repository_bindings (
        id, workspace_id, connection_id, repository_id, repository_url, owner, name, default_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["srb_existing", "local", "scm_github", "repo_bound", "git@github.com:acme/bound.git", "acme", "bound", "main", timestamp, timestamp],
    );
    database.run(
      `INSERT INTO multiremi_scm_repository_bindings (
        id, workspace_id, connection_id, repository_id, repository_url, owner, name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["srb_codebase", "local", "scm_codebase_one", "repo_codebase", "git@code.byted.org:acme/internal.git", "acme", "internal", timestamp, timestamp],
    );

    migrate(database);

    expect(database.query(
      `SELECT id, base_url, repository_scope, is_default FROM multiremi_scm_connections
       WHERE provider = 'github' ORDER BY id`,
    ).all()).toEqual([
      { id: "scm_github", base_url: "https://github.com", repository_scope: "all", is_default: 1 },
      {
        id: "scm_github_enterprise",
        base_url: "https://github.acme.test",
        repository_scope: "all",
        is_default: 1,
      },
    ]);
    expect(database.query(
      `SELECT id, repository_scope, is_default FROM multiremi_scm_connections
       WHERE provider = 'codebase' ORDER BY id`,
    ).all()).toEqual([
      { id: "scm_codebase_one", repository_scope: "selected", is_default: 0 },
      { id: "scm_codebase_two", repository_scope: "selected", is_default: 0 },
    ]);
    expect(database.query(
      `SELECT repository_id, assignment_origin
       FROM multiremi_scm_repository_bindings ORDER BY repository_id`,
    ).all()).toEqual([
      { repository_id: "repo_bound", assignment_origin: "default" },
      { repository_id: "repo_codebase", assignment_origin: "explicit" },
      { repository_id: "repo_enterprise", assignment_origin: "default" },
      { repository_id: "repo_missing", assignment_origin: "default" },
    ]);
  });

  it("atomically normalizes path-shaped SCM origins and resolves duplicate defaults", () => {
    const database = freshDb();
    migrate(database);
    database.run(
      "DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260822_scm_connection_origins"],
    );
    const timestamp = "2026-08-21T00:00:00.000Z";
    database.run(
      `INSERT INTO multiremi_workspaces (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["origin-migration", "Origin migration", "origin-migration", timestamp, timestamp],
    );
    for (const [id, name, baseUrl, createdAt] of [
      ["scm_origin_first", "First", "https://github.com/acme/first", "2026-08-20T00:00:00.000Z"],
      ["scm_origin_second", "Second", "https://github.com/acme/second/", "2026-08-21T00:00:00.000Z"],
    ]) {
      database.run(
        `INSERT INTO multiremi_scm_connections (
          id, workspace_id, name, provider, mode, base_url, api_base_url,
          repository_scope, is_default, created_at, updated_at
         ) VALUES (?, 'origin-migration', ?, 'github', 'poll', ?, 'https://api.github.com',
                   'all', 1, ?, ?)`,
        [id, name, baseUrl, createdAt, createdAt],
      );
      database.run(
        `INSERT INTO multiremi_scm_repository_bindings (
          id, workspace_id, connection_id, repository_id, repository_url, name,
          assignment_origin, created_at, updated_at
         ) VALUES (?, 'origin-migration', ?, ?, ?, ?, 'default', ?, ?)`,
        [
          `binding_${id}`,
          id,
          `repo_${id}`,
          `https://github.com/acme/${name.toLowerCase()}.git`,
          name,
          createdAt,
          createdAt,
        ],
      );
    }
    database.exec(`
      CREATE TRIGGER abort_scm_origin_normalization
      BEFORE UPDATE OF base_url ON multiremi_scm_connections
      WHEN NEW.base_url != OLD.base_url
      BEGIN
        SELECT RAISE(ABORT, 'simulated origin migration interruption');
      END;
    `);

    expect(() => migrate(database)).toThrow(/simulated origin migration interruption/);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = '20260822_scm_connection_origins'",
    ).get()).toEqual({ count: 0 });
    expect(database.query(
      `SELECT id, base_url, repository_scope, is_default FROM multiremi_scm_connections
       WHERE workspace_id = 'origin-migration' ORDER BY id`,
    ).all()).toEqual([
      {
        id: "scm_origin_first",
        base_url: "https://github.com/acme/first",
        repository_scope: "all",
        is_default: 1,
      },
      {
        id: "scm_origin_second",
        base_url: "https://github.com/acme/second/",
        repository_scope: "all",
        is_default: 1,
      },
    ]);

    database.exec("DROP TRIGGER abort_scm_origin_normalization");
    migrate(database);
    expect(database.query(
      `SELECT id, base_url, repository_scope, is_default FROM multiremi_scm_connections
       WHERE workspace_id = 'origin-migration' ORDER BY id`,
    ).all()).toEqual([
      { id: "scm_origin_first", base_url: "https://github.com", repository_scope: "all", is_default: 1 },
      { id: "scm_origin_second", base_url: "https://github.com", repository_scope: "selected", is_default: 0 },
    ]);
    expect(database.query(
      `SELECT connection_id, assignment_origin FROM multiremi_scm_repository_bindings
       WHERE workspace_id = 'origin-migration' ORDER BY connection_id`,
    ).all()).toEqual([
      { connection_id: "scm_origin_first", assignment_origin: "default" },
      { connection_id: "scm_origin_second", assignment_origin: "explicit" },
    ]);

    database.run(
      "DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260822_scm_connection_origins"],
    );
    migrate(database);
    expect(database.query(
      `SELECT id, repository_scope, is_default FROM multiremi_scm_connections
       WHERE workspace_id = 'origin-migration' ORDER BY id`,
    ).all()).toEqual([
      { id: "scm_origin_first", repository_scope: "all", is_default: 1 },
      { id: "scm_origin_second", repository_scope: "selected", is_default: 0 },
    ]);
  });

  it("resumes the SCM default backfill after an interrupted column upgrade and never replays it", () => {
    const database = freshDb();
    migrate(database);
    database.run(
      "DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260822_scm_default_repository_scope"],
    );
    const timestamp = "2026-08-21T00:00:00.000Z";
    database.run(
      `INSERT INTO multiremi_workspaces (id, name, slug, repos, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "migration-resume",
        "Migration resume",
        "migration-resume",
        JSON.stringify([
          { id: "repo_resume", name: "resume", url: "git@github.com:acme/resume.git", source: "github" },
        ]),
        timestamp,
        timestamp,
      ],
    );
    database.run(
      `INSERT INTO multiremi_scm_connections (
        id, workspace_id, name, provider, mode, base_url, api_base_url,
        repository_scope, is_default, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'selected', 0, ?, ?)`,
      [
        "scm_resume",
        "migration-resume",
        "GitHub",
        "github",
        "poll",
        "https://github.com",
        "https://api.github.com",
        timestamp,
        timestamp,
      ],
    );

    migrate(database);
    expect(database.query(
      "SELECT repository_scope, is_default FROM multiremi_scm_connections WHERE id = 'scm_resume'",
    ).get()).toEqual({ repository_scope: "all", is_default: 1 });
    expect(database.query(
      "SELECT assignment_origin FROM multiremi_scm_repository_bindings WHERE repository_id = 'repo_resume'",
    ).get()).toEqual({ assignment_origin: "default" });

    database.run(
      "UPDATE multiremi_scm_connections SET repository_scope = 'selected', is_default = 0 WHERE id = 'scm_resume'",
    );
    database.run(
      "UPDATE multiremi_scm_repository_bindings SET assignment_origin = 'explicit' WHERE repository_id = 'repo_resume'",
    );
    migrate(database);
    expect(database.query(
      "SELECT repository_scope, is_default FROM multiremi_scm_connections WHERE id = 'scm_resume'",
    ).get()).toEqual({ repository_scope: "selected", is_default: 0 });
    expect(database.query(
      "SELECT assignment_origin FROM multiremi_scm_repository_bindings WHERE repository_id = 'repo_resume'",
    ).get()).toEqual({ assignment_origin: "explicit" });
  });

  it("adds system-event run columns before creating their unique index", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_autopilot_runs (
        id TEXT PRIMARY KEY,
        autopilot_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        issue_id TEXT,
        task_id TEXT,
        triggered_at TEXT NOT NULL,
        completed_at TEXT,
        failure_reason TEXT,
        payload TEXT,
        result TEXT,
        created_at TEXT NOT NULL
      )
    `);

    migrate(database);

    expect(columnNames(database, "multiremi_autopilot_runs")).toEqual(expect.arrayContaining([
      "trigger_id", "event_id", "issue_session_id", "repository_id", "dedupe_key",
    ]));
    expect(database.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get("idx_multiremi_autopilot_runs_system_event")).toEqual({
      name: "idx_multiremi_autopilot_runs_system_event",
    });
    expect(database.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get("idx_multiremi_autopilot_runs_repository")).toEqual({
      name: "idx_multiremi_autopilot_runs_repository",
    });
  });

  it("backfills a daemon owner claim only when existing active identities agree", () => {
    const database = freshDb();
    migrate(database);
    const createdAt = "2026-08-01T00:00:00.000Z";
    database.run(
      `INSERT INTO multiremi_runtimes (
         id, name, provider, daemon_id, workspace_id, owner_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["rt_owner_backfill", "Backfill runtime", "claude", "daemon-owner-backfill", "local", "owner-a", createdAt, createdAt],
    );
    database.run(
      `INSERT INTO multiremi_access_tokens (
         id, workspace_id, daemon_id, user_id, name, type, purpose,
         token_hash, token_prefix, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["dtk_owner_backfill", "local", "daemon-owner-backfill", "owner-a", "Backfill token", "daemon", "daemon", "hash-owner-a", "mdt_owner_a", createdAt],
    );

    migrate(database);
    expect(database.query(
      `SELECT owner_user_id
       FROM multiremi_daemon_lifecycle_locks
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get("local", "daemon-owner-backfill")).toEqual({ owner_user_id: "owner-a" });

    database.run(
      `INSERT INTO multiremi_access_tokens (
         id, workspace_id, daemon_id, user_id, name, type, purpose,
         token_hash, token_prefix, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["dtk_owner_conflict", "local", "daemon-owner-backfill", "owner-b", "Conflicting token", "daemon", "daemon", "hash-owner-b", "mdt_owner_b", createdAt],
    );
    database.run(
      `UPDATE multiremi_daemon_lifecycle_locks
       SET owner_user_id = NULL
       WHERE workspace_id = ? AND daemon_id = ?`,
      ["local", "daemon-owner-backfill"],
    );
    migrate(database);
    expect(database.query(
      `SELECT owner_user_id
       FROM multiremi_daemon_lifecycle_locks
       WHERE workspace_id = ? AND daemon_id = ?`,
    ).get("local", "daemon-owner-backfill")).toEqual({ owner_user_id: null });
  });

  it("makes only still-valid daemon credentials non-expiring without reviving expired or revoked tokens", () => {
    const database = freshDb();
    migrate(database);
    const createdAt = "2026-08-01T00:00:00.000Z";
    const future = "2999-01-01T00:00:00.000Z";
    const expired = "2000-01-01T00:00:00.000Z";
    const insert = database.prepare(
      `INSERT INTO multiremi_access_tokens (
         id, workspace_id, daemon_id, user_id, name, type, purpose,
         token_hash, token_prefix, expires_at, revoked_at, created_at
       ) VALUES (?, 'local', ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("daemon-active", "daemon-active", "Active daemon", "daemon", "daemon", "hash-active", "mdt_active", future, null, createdAt);
    insert.run("daemon-expired", "daemon-expired", "Expired daemon", "daemon", "daemon", "hash-expired", "mdt_expired", expired, null, createdAt);
    insert.run("daemon-revoked", "daemon-revoked", "Revoked daemon", "daemon", "daemon", "hash-revoked", "mdt_revoked", future, createdAt, createdAt);
    insert.run("daemon-unbound", null, "Unbound daemon", "daemon", "daemon", "hash-unbound", "mdt_unbound", future, null, createdAt);
    insert.run("pat-active", null, "Active PAT", "pat", "personal", "hash-pat", "mul_active", future, null, createdAt);

    migrate(database);

    const rows = database.query(
      "SELECT id, expires_at FROM multiremi_access_tokens ORDER BY id",
    ).all() as Array<{ id: string; expires_at: string | null }>;
    expect(rows).toEqual([
      { id: "daemon-active", expires_at: null },
      { id: "daemon-expired", expires_at: expired },
      { id: "daemon-revoked", expires_at: future },
      { id: "daemon-unbound", expires_at: future },
      { id: "pat-active", expires_at: future },
    ]);
  });

  it("adds Plugin source subdirectories without losing existing catalog rows", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_agent_plugins (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manifest',
        source_url TEXT,
        source_ref TEXT,
        active_version_id TEXT,
        candidate_version_id TEXT,
        created_by TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, provider, name)
      )
    `);
    database.run(
      `INSERT INTO multiremi_agent_plugins (
         id, provider, name, source_type, source_url, source_ref, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "apl_existing",
        "claude",
        "Existing",
        "git",
        "https://example.com/plugins.git",
        "main",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ],
    );

    migrate(database);

    expect(columnNames(database, "multiremi_agent_plugins")).toContain("source_subdir");
    expect(database.query(
      "SELECT name, source_url, source_ref, source_subdir FROM multiremi_agent_plugins WHERE id = ?",
    ).get("apl_existing")).toEqual({
      name: "Existing",
      source_url: "https://example.com/plugins.git",
      source_ref: "main",
      source_subdir: null,
    });
  });

  it("backfills archived_at for legacy completed and cancelled projects", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'planned',
        updated_at TEXT NOT NULL
      )
    `);
    database.run(
      "INSERT INTO multiremi_projects (id, status, updated_at) VALUES (?, ?, ?)",
      ["prj_cancelled", "cancelled", "2026-08-01T00:00:00.000Z"],
    );
    database.run(
      "INSERT INTO multiremi_projects (id, status, updated_at) VALUES (?, ?, ?)",
      ["prj_active", "in_progress", "2026-08-02T00:00:00.000Z"],
    );

    migrate(database);

    expect(columnNames(database, "multiremi_projects")).toContain("archived_at");
    expect(columnNames(database, "multiremi_projects")).toEqual(expect.arrayContaining([
      "instructions",
      "instructions_revision",
      "instructions_updated_at",
      "instructions_updated_by",
    ]));
    // Upgrade path also patches in the project default-assignee columns.
    expect(columnNames(database, "multiremi_projects")).toContain("default_assignee_type");
    expect(columnNames(database, "multiremi_projects")).toContain("default_assignee_id");
    const rows = database.query(
      `SELECT id, archived_at, instructions, instructions_revision,
              instructions_updated_at, instructions_updated_by
       FROM multiremi_projects ORDER BY id`,
    ).all() as Array<{
      id: string;
      archived_at: string | null;
      instructions: string;
      instructions_revision: number;
      instructions_updated_at: string | null;
      instructions_updated_by: string | null;
    }>;
    expect(rows).toEqual([
      {
        id: "prj_active",
        archived_at: null,
        instructions: "",
        instructions_revision: 0,
        instructions_updated_at: null,
        instructions_updated_by: null,
      },
      {
        id: "prj_cancelled",
        archived_at: "2026-08-01T00:00:00.000Z",
        instructions: "",
        instructions_revision: 0,
        instructions_updated_at: null,
        instructions_updated_by: null,
      },
    ]);
  });

  it("renames legacy multica_* objects on every startup", () => {
    const database = freshDb();
    database.exec("CREATE TABLE multica_legacy_notes (id TEXT PRIMARY KEY, body TEXT)");
    database.exec("CREATE INDEX idx_multica_legacy_notes_body ON multica_legacy_notes(body)");
    database.run("INSERT INTO multica_legacy_notes (id, body) VALUES (?, ?)", ["n1", "carried over"]);

    migrate(database);

    const tables = tableNames(database);
    expect(tables).toContain("multiremi_legacy_notes");
    expect(tables).not.toContain("multica_legacy_notes");
    const row = database.query("SELECT body FROM multiremi_legacy_notes WHERE id = ?").get("n1") as { body?: string } | null;
    expect(row?.body).toBe("carried over");
    const indexes = (database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(indexes).not.toContain("idx_multica_legacy_notes_body");
  });

  it("upgrades a pre-typed issue subscribers table", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_issue_subscribers (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, member_id)
      )
    `);
    database.run(
      "INSERT INTO multiremi_issue_subscribers (id, issue_id, member_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      ["sub_1", "iss_1", "mem_1", "assigned", "2026-01-01T00:00:00.000Z"],
    );

    migrate(database);

    const columns = columnNames(database, "multiremi_issue_subscribers");
    expect(columns).toContain("user_type");
    expect(columns).toContain("user_id");
    const row = database.query("SELECT user_type, user_id FROM multiremi_issue_subscribers WHERE id = ?").get("sub_1") as
      { user_type?: string; user_id?: string } | null;
    expect(row?.user_type).toBe("member");
    expect(row?.user_id).toBe("mem_1");
  });

  it("relaxes a legacy issue-bound inbox table", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_inbox_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    database.run(
      `INSERT INTO multiremi_inbox_items (id, workspace_id, issue_id, member_id, type, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["inb_1", "local", "iss_1", "mem_1", "issue_assigned", "Old item", "2026-01-01T00:00:00.000Z"],
    );

    migrate(database);

    const issueColumn = (database.query("PRAGMA table_info(multiremi_inbox_items)").all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === "issue_id");
    expect(Number(issueColumn?.notnull ?? 1)).toBe(0);
    const row = database.query("SELECT recipient_type, recipient_id, severity FROM multiremi_inbox_items WHERE id = ?").get("inb_1") as
      { recipient_type?: string; recipient_id?: string; severity?: string } | null;
    expect(row?.recipient_type).toBe("member");
    expect(row?.recipient_id).toBe("mem_1");
    expect(row?.severity).toBe("info");
    expect(tableNames(database)).not.toContain("multiremi_inbox_items_legacy");
  });

  it("repairs duplicate squad leader roles from the squad leader id", () => {
    const database = freshDb();
    migrate(database);
    database.run(
      `INSERT INTO multiremi_squads (id, name, leader_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["sqd_1", "Workers", "agt_new", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    database.run(
      `INSERT INTO multiremi_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES (?, ?, 'agent', ?, 'leader', ?)`,
      ["sqm_old", "sqd_1", "agt_old", "2026-01-01T00:00:00.000Z"],
    );
    database.run(
      `INSERT INTO multiremi_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES (?, ?, 'agent', ?, 'member', ?)`,
      ["sqm_new", "sqd_1", "agt_new", "2026-01-01T00:00:01.000Z"],
    );

    migrate(database);

    const roles = database.query(
      "SELECT member_id, role FROM multiremi_squad_members WHERE squad_id = ? ORDER BY member_id",
    ).all("sqd_1") as Array<{ member_id: string; role: string }>;
    expect(roles).toEqual([
      { member_id: "agt_new", role: "leader" },
      { member_id: "agt_old", role: "member" },
    ]);
    expect(() => database.run(
      `INSERT INTO multiremi_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES ('sqm_extra', 'sqd_1', 'agent', 'agt_extra', 'leader', '2026-01-01T00:00:02.000Z')`,
    )).toThrow();
  });
});
