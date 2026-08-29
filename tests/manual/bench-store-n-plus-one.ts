import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { MultiremiStore } from "../../packages/server/src/store/store.js";

type SqlCount = { sql: string; count: number };

interface CountingDatabase {
  database: Database;
  proxy: Database;
  reset(): void;
  snapshot(): SqlCount[];
  total(): number;
}

interface BenchmarkCase {
  name: string;
  unit: string;
  seed(database: Database, n: number): void;
  run(store: MultiremiStore): unknown;
}

interface BenchmarkPoint {
  n: number;
  sqlCount: number;
  p50Ms: number;
  topSql: SqlCount[];
}

const SIZES = [0, 50, 200, 500];
const SAMPLES = 11;
const OUTPUT_PATH = process.env.MUL175_BENCH_OUTPUT ?? "/tmp/mul175-store-n-plus-one.json";
const NOW = "2026-08-28T04:00:00.000Z";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function countingDatabase(): CountingDatabase {
  const database = new Database(":memory:");
  const counts = new Map<string, number>();
  const proxy = new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if ((key === "query" || key === "run") && typeof value === "function") {
        return (sql: string, ...args: unknown[]) => {
          const normalized = normalizeSql(sql);
          counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
          return Reflect.apply(value, target, [sql, ...args]);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
  return {
    database,
    proxy,
    reset: () => counts.clear(),
    snapshot: () => [...counts.entries()]
      .map(([sql, count]) => ({ sql, count }))
      .sort((left, right) => right.count - left.count || left.sql.localeCompare(right.sql)),
    total: () => [...counts.values()].reduce((sum, count) => sum + count, 0),
  };
}

function transaction(database: Database, callback: () => void): void {
  database.transaction(callback)();
}

function seedWorkspace(database: Database, workspaceId = "local"): void {
  database.run(
    "INSERT OR IGNORE INTO multiremi_workspaces (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [workspaceId, workspaceId, workspaceId, NOW, NOW],
  );
}

function seedUser(database: Database, userId = "user_bench"): void {
  database.run(
    "INSERT OR IGNORE INTO multiremi_users (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [userId, "Bench User", `${userId}@example.com`, NOW, NOW],
  );
}

function seedAgent(database: Database, agentId = "agent_bench"): void {
  database.run(
    "INSERT OR IGNORE INTO multiremi_agents (id, name, provider, workspace_id, created_at, updated_at) VALUES (?, ?, 'claude', 'local', ?, ?)",
    [agentId, agentId, NOW, NOW],
  );
}

const cases: BenchmarkCase[] = [
  {
    name: "RuntimesRepo.listRuntimes",
    unit: "runtimes",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const runtimeId = `runtime_${index}`;
          database.run(
            "INSERT INTO multiremi_runtimes (id, name, provider, workspace_id, status, created_at, updated_at) VALUES (?, ?, 'claude', 'local', 'offline', ?, ?)",
            [runtimeId, runtimeId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_runtime_models (runtime_id, model_id, label, provider, is_default, created_at, updated_at) VALUES (?, ?, ?, 'claude', 1, ?, ?)",
            [runtimeId, `model_${index}`, `Model ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listRuntimes(),
  },
  {
    name: "AgentsSkillsRepo.listAgents",
    unit: "agents (one shared skill each)",
    seed(database, n) {
      seedWorkspace(database);
      database.run(
        "INSERT INTO multiremi_skills (id, name, workspace_id, created_at, updated_at) VALUES ('skill_shared', 'Shared', 'local', ?, ?)",
        [NOW, NOW],
      );
      database.run(
        "INSERT INTO multiremi_skill_files (id, skill_id, path, content, created_at, updated_at) VALUES ('file_shared', 'skill_shared', 'SKILL.md', '# Shared', ?, ?)",
        [NOW, NOW],
      );
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const agentId = `agent_${index}`;
          database.run(
            "INSERT INTO multiremi_agents (id, name, provider, workspace_id, created_at, updated_at) VALUES (?, ?, 'claude', 'local', ?, ?)",
            [agentId, agentId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_agent_skills (agent_id, skill_id, created_at) VALUES (?, 'skill_shared', ?)",
            [agentId, NOW],
          );
        }
      });
    },
    run: (store) => store.listAgents(),
  },
  {
    name: "AgentsSkillsRepo.listSkills(includeFiles=true)",
    unit: "skills (one file each)",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const skillId = `skill_${index}`;
          database.run(
            "INSERT INTO multiremi_skills (id, name, workspace_id, created_at, updated_at) VALUES (?, ?, 'local', ?, ?)",
            [skillId, skillId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_skill_files (id, skill_id, path, content, created_at, updated_at) VALUES (?, ?, 'SKILL.md', '# Bench', ?, ?)",
            [`file_${index}`, skillId, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listSkills("local", { includeFiles: true }),
  },
  {
    name: "AgentsSkillsRepo.listAgentSkills(includeFiles=true)",
    unit: "skills bound to one agent (one file each)",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const skillId = `skill_${index}`;
          database.run(
            "INSERT INTO multiremi_skills (id, name, workspace_id, created_at, updated_at) VALUES (?, ?, 'local', ?, ?)",
            [skillId, skillId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_skill_files (id, skill_id, path, content, created_at, updated_at) VALUES (?, ?, 'SKILL.md', '# Bench', ?, ?)",
            [`file_${index}`, skillId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_agent_skills (agent_id, skill_id, created_at) VALUES ('agent_bench', ?, ?)",
            [skillId, NOW],
          );
        }
      });
    },
    run: (store) => store.listAgentSkills("agent_bench", { includeFiles: true }),
  },
  {
    name: "AgentPluginsRepo.listAgentPlugins",
    unit: "plugins (one active version each)",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const pluginId = `plugin_${index}`;
          const versionId = `version_${index}`;
          database.run(
            "INSERT INTO multiremi_agent_plugins (id, workspace_id, provider, name, created_at, updated_at) VALUES (?, 'local', 'claude', ?, ?, ?)",
            [pluginId, pluginId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_agent_plugin_versions (id, plugin_id, version, manifest_path, artifact_json, artifact_digest, created_at) VALUES (?, ?, '1.0.0', '.claude-plugin/plugin.json', '{}', ?, ?)",
            [versionId, pluginId, `digest_${index}`, NOW],
          );
          database.run("UPDATE multiremi_agent_plugins SET active_version_id = ? WHERE id = ?", [versionId, pluginId]);
        }
      });
    },
    run: (store) => store.listAgentPlugins("local"),
  },
  {
    name: "AgentPluginsRepo.listAgentPluginBindings",
    unit: "bindings (one active plugin each)",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const pluginId = `plugin_${index}`;
          const versionId = `version_${index}`;
          database.run(
            "INSERT INTO multiremi_agent_plugins (id, workspace_id, provider, name, created_at, updated_at) VALUES (?, 'local', 'claude', ?, ?, ?)",
            [pluginId, pluginId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_agent_plugin_versions (id, plugin_id, version, manifest_path, artifact_json, artifact_digest, created_at) VALUES (?, ?, '1.0.0', '.claude-plugin/plugin.json', '{}', ?, ?)",
            [versionId, pluginId, `digest_${index}`, NOW],
          );
          database.run("UPDATE multiremi_agent_plugins SET active_version_id = ? WHERE id = ?", [versionId, pluginId]);
          database.run(
            "INSERT INTO multiremi_agent_plugin_bindings (id, agent_id, plugin_id, enabled, version_policy, created_at, updated_at) VALUES (?, 'agent_bench', ?, 1, 'follow_active', ?, ?)",
            [`binding_${index}`, pluginId, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listAgentPluginBindings("agent_bench"),
  },
  {
    name: "AgentPluginsRepo.listAgentPluginRuntimeStates",
    unit: "runtime states for one bound plugin",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      database.run(
        "INSERT INTO multiremi_agent_plugins (id, workspace_id, provider, name, created_at, updated_at) VALUES ('plugin_bench', 'local', 'claude', 'Bench plugin', ?, ?)",
        [NOW, NOW],
      );
      database.run(
        "INSERT INTO multiremi_agent_plugin_versions (id, plugin_id, version, manifest_path, artifact_json, artifact_digest, created_at) VALUES ('version_bench', 'plugin_bench', '1.0.0', '.claude-plugin/plugin.json', '{}', 'digest_bench', ?)",
        [NOW],
      );
      database.run("UPDATE multiremi_agent_plugins SET active_version_id = 'version_bench' WHERE id = 'plugin_bench'");
      database.run(
        "INSERT INTO multiremi_agent_plugin_bindings (id, agent_id, plugin_id, enabled, version_policy, created_at, updated_at) VALUES ('binding_bench', 'agent_bench', 'plugin_bench', 1, 'follow_active', ?, ?)",
        [NOW, NOW],
      );
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_runtimes (id, name, provider, workspace_id, status, created_at, updated_at) VALUES (?, ?, 'claude', 'local', 'offline', ?, ?)",
            [`runtime_${index}`, `runtime_${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listAgentPluginRuntimeStates({ workspaceId: "local" }),
  },
  {
    name: "AgentPluginsRepo.runtimeHasReadyAgentPlugins",
    unit: "ready plugin bindings for one runtime/agent pair",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      database.run(
        "INSERT INTO multiremi_runtimes (id, name, provider, workspace_id, status, created_at, updated_at) VALUES ('runtime_bench', 'Bench runtime', 'claude', 'local', 'online', ?, ?)",
        [NOW, NOW],
      );
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const pluginId = `plugin_${index}`;
          const versionId = `version_${index}`;
          const digest = `digest_${index}`;
          database.run(
            "INSERT INTO multiremi_agent_plugins (id, workspace_id, provider, name, created_at, updated_at) VALUES (?, 'local', 'claude', ?, ?, ?)",
            [pluginId, pluginId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_agent_plugin_versions (id, plugin_id, version, manifest_path, artifact_json, artifact_digest, created_at) VALUES (?, ?, '1.0.0', '.claude-plugin/plugin.json', '{}', ?, ?)",
            [versionId, pluginId, digest, NOW],
          );
          database.run("UPDATE multiremi_agent_plugins SET active_version_id = ? WHERE id = ?", [versionId, pluginId]);
          database.run(
            "INSERT INTO multiremi_agent_plugin_bindings (id, agent_id, plugin_id, enabled, version_policy, created_at, updated_at) VALUES (?, 'agent_bench', ?, 1, 'follow_active', ?, ?)",
            [`binding_${index}`, pluginId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_agent_plugin_runtime_states (id, workspace_id, runtime_id, plugin_id, plugin_version_id, desired, desired_reason, status, observed_digest, created_at, updated_at) VALUES (?, 'local', 'runtime_bench', ?, ?, 1, 'active_binding', 'ready', ?, ?, ?)",
            [`state_${index}`, pluginId, versionId, digest, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.runtimeHasReadyAgentPlugins("runtime_bench", "agent_bench"),
  },
  {
    name: "ScmRepo.listConnectionsWithRepositories",
    unit: "connections (one repository each)",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const connectionId = `connection_${index}`;
          database.run(
            "INSERT INTO multiremi_scm_connections (id, workspace_id, name, provider, base_url, api_base_url, created_at, updated_at) VALUES (?, 'local', ?, 'github', 'https://github.com', 'https://api.github.com', ?, ?)",
            [connectionId, connectionId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_scm_repository_bindings (id, workspace_id, connection_id, repository_id, repository_url, name, created_at, updated_at) VALUES (?, 'local', ?, ?, ?, ?, ?, ?)",
            [`binding_${index}`, connectionId, `repository_${index}`, `https://github.com/example/repository-${index}`, `repository-${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listScmConnectionsWithRepositories({ workspaceId: "local" }),
  },
  {
    name: "WorkspacesRepo.listWorkspacesForUser",
    unit: "workspaces",
    seed(database, n) {
      seedUser(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const workspaceId = `workspace_${index}`;
          database.run(
            "INSERT INTO multiremi_workspaces (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            [workspaceId, workspaceId, workspaceId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_workspace_members (id, workspace_id, user_id, name, role, created_at, updated_at) VALUES (?, ?, 'user_bench', 'Bench User', 'member', ?, ?)",
            [`member_${index}`, workspaceId, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listWorkspacesForUser("user_bench"),
  },
  {
    name: "WorkspacesRepo.listWorkspaceInvitations",
    unit: "invitations",
    seed(database, n) {
      seedWorkspace(database);
      seedUser(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_workspace_invitations (id, workspace_id, inviter_id, invitee_email, status, expires_at, created_at, updated_at) VALUES (?, 'local', 'user_bench', ?, 'pending', '2099-01-01T00:00:00.000Z', ?, ?)",
            [`invitation_${index}`, `invitee-${index}@example.com`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listWorkspaceInvitations("local"),
  },
  {
    name: "ChatRepo.listPendingChatTasks(creatorId)",
    unit: "pending chat tasks",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const sessionId = `chat_${index}`;
          database.run(
            "INSERT INTO multiremi_chat_sessions (id, workspace_id, agent_id, creator_id, title, status, created_at, updated_at) VALUES (?, 'local', 'agent_bench', 'user_bench', ?, 'active', ?, ?)",
            [sessionId, sessionId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_tasks (id, workspace_id, agent_id, chat_session_id, status, prompt, created_at, updated_at) VALUES (?, 'local', 'agent_bench', ?, 'queued', 'bench', ?, ?)",
            [`task_${index}`, sessionId, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listPendingChatTasks("local", { creatorId: "user_bench" }),
  },
  {
    name: "IssuesRepo.listInboxItems",
    unit: "inbox items",
    seed(database, n) {
      seedWorkspace(database);
      seedUser(database);
      database.run(
        "INSERT INTO multiremi_workspace_members (id, workspace_id, user_id, name, role, created_at, updated_at) VALUES ('member_bench', 'local', 'user_bench', 'Bench User', 'member', ?, ?)",
        [NOW, NOW],
      );
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const issueId = `issue_${index}`;
          database.run(
            "INSERT INTO multiremi_issues (id, workspace_id, title, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)",
            [issueId, issueId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_inbox_items (id, member_id, issue_id, type, title, archived, created_at) VALUES (?, 'member_bench', ?, 'mention', ?, 0, ?)",
            [`inbox_${index}`, issueId, issueId, NOW],
          );
        }
      });
    },
    run: (store) => store.listInboxItems("member_bench"),
  },
  {
    name: "IssuesRepo.searchIssues(includeCommentBodies=true)",
    unit: "issues",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_issues (id, workspace_id, title, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)",
            [`issue_${index}`, `Issue ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.searchIssues({ q: "not-present", workspaceId: "local", includeCommentBodies: true }),
  },
  {
    name: "IssuesRepo.createIssueComment(subscriber fan-out)",
    unit: "member subscribers",
    seed(database, n) {
      seedWorkspace(database);
      seedUser(database, "comment_author");
      database.run(
        "INSERT INTO multiremi_issues (id, workspace_id, title, status, created_at, updated_at) VALUES ('issue_bench', 'local', 'Bench issue', 'backlog', ?, ?)",
        [NOW, NOW],
      );
      database.run(
        "INSERT INTO multiremi_issue_sessions (id, issue_id, workspace_id, title, status, is_default, created_at, updated_at) VALUES ('session_bench', 'issue_bench', 'local', 'Main', 'active', 1, ?, ?)",
        [NOW, NOW],
      );
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          const memberId = `member_${index}`;
          database.run(
            "INSERT INTO multiremi_workspace_members (id, workspace_id, user_id, name, role, created_at, updated_at) VALUES (?, 'local', ?, ?, 'member', ?, ?)",
            [memberId, `subscriber_user_${index}`, memberId, NOW, NOW],
          );
          database.run(
            "INSERT INTO multiremi_issue_subscribers (id, issue_id, member_id, user_type, user_id, reason, created_at) VALUES (?, 'issue_bench', ?, 'member', ?, 'manual', ?)",
            [`subscriber_${index}`, memberId, memberId, NOW],
          );
        }
      });
    },
    run: (store) => store.createIssueComment("issue_bench", {
      authorType: "member",
      authorId: "comment_author",
      issueSessionId: "session_bench",
      body: "Bench comment without mentions",
    }),
  },
  {
    name: "DaemonRetirementRepo.getPlan",
    unit: "offline runtimes on one daemon",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_runtimes (id, name, provider, workspace_id, daemon_id, status, created_at, updated_at) VALUES (?, ?, 'claude', 'local', 'daemon_bench', 'offline', ?, ?)",
            [`runtime_${index}`, `runtime_${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.getDaemonRetirementPlan("local", "daemon_bench"),
  },
  {
    name: "CONTROL TasksRepo.listTasks",
    unit: "tasks",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_tasks (id, workspace_id, agent_id, status, prompt, created_at, updated_at) VALUES (?, 'local', 'agent_bench', 'completed', 'bench', ?, ?)",
            [`task_${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listTasks(),
  },
  {
    name: "CONTROL UsageRepo.listUsageDaily",
    unit: "tasks with usage",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      const usage = JSON.stringify([{ provider: "claude", model: "bench", inputTokens: 1, outputTokens: 1 }]);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_tasks (id, workspace_id, agent_id, status, prompt, usage, created_at, updated_at) VALUES (?, 'local', 'agent_bench', 'completed', 'bench', ?, ?, ?)",
            [`task_${index}`, usage, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listUsageDaily({ workspaceId: "local", days: 30 }),
  },
  {
    name: "CONTROL ProjectsRepo.searchProjects",
    unit: "projects",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_projects (id, workspace_id, title, description, created_at, updated_at) VALUES (?, 'local', ?, 'bench description', ?, ?)",
            [`project_${index}`, `Project ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.searchProjects({ q: "not-present", workspaceId: "local" }),
  },
  {
    name: "CONTROL SquadsRepo.listSquads",
    unit: "squads",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_squads (id, workspace_id, name, created_at, updated_at) VALUES (?, 'local', ?, ?, ?)",
            [`squad_${index}`, `Squad ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listSquads("local"),
  },
  {
    name: "CONTROL RepositoryWikiRepo.list",
    unit: "repository wiki docs",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_repository_wiki_docs (id, workspace_id, repository_id, path, title, created_at, updated_at) VALUES (?, 'local', 'repository_bench', ?, ?, ?, ?)",
            [`wiki_${index}`, `doc-${index}.md`, `Doc ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listRepositoryWikiDocs("local", "repository_bench"),
  },
  {
    name: "CONTROL SessionArchivesRepo.list",
    unit: "session archives",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_session_archives (id, workspace_id, issue_id, runtime_id, daemon_id, source_revision, sha256, size_bytes, relative_path, created_at, updated_at) VALUES (?, 'local', 'issue_bench', 'runtime_bench', 'daemon_bench', ?, ?, 0, ?, ?, ?)",
            [`archive_${index}`, `revision_${index}`, `sha_${index}`, `archive-${index}.tar.gz`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listSessionArchives("issue_bench"),
  },
  {
    name: "CONTROL AutopilotsRepo.listAutopilots",
    unit: "autopilots",
    seed(database, n) {
      seedWorkspace(database);
      seedAgent(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_autopilots (id, workspace_id, title, assignee_type, assignee_id, status, created_at, updated_at) VALUES (?, 'local', ?, 'agent', 'agent_bench', 'active', ?, ?)",
            [`autopilot_${index}`, `Autopilot ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listAutopilots("local"),
  },
  {
    name: "CONTROL NotificationChannelsRepo.listChannels",
    unit: "notification channels",
    seed(database, n) {
      seedWorkspace(database);
      transaction(database, () => {
        for (let index = 0; index < n; index += 1) {
          database.run(
            "INSERT INTO multiremi_notification_channels (id, workspace_id, kind, name, target, event_types, created_at, updated_at) VALUES (?, 'local', 'feishu_chat', ?, '{\"chatId\":\"bench\"}', '[\"comment_created\"]', ?, ?)",
            [`channel_${index}`, `Channel ${index}`, NOW, NOW],
          );
        }
      });
    },
    run: (store) => store.listNotificationChannels("local"),
  },
];

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function benchmark(entry: BenchmarkCase, n: number): BenchmarkPoint {
  const counted = countingDatabase();
  try {
    const store = new MultiremiStore(counted.proxy);
    entry.seed(counted.database, n);
    counted.reset();
    entry.run(store);
    counted.reset();

    const durations: number[] = [];
    let sqlCount = 0;
    let topSql: SqlCount[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      counted.reset();
      const startedAt = performance.now();
      entry.run(store);
      durations.push(performance.now() - startedAt);
      const currentCount = counted.total();
      if (sample === 0) {
        sqlCount = currentCount;
        topSql = counted.snapshot().slice(0, 8);
      } else if (currentCount !== sqlCount) {
        throw new Error(`${entry.name}@${n} emitted unstable SQL counts: ${sqlCount} then ${currentCount}`);
      }
    }
    return { n, sqlCount, p50Ms: Number(median(durations).toFixed(3)), topSql };
  } finally {
    counted.database.close();
  }
}

const selectedNames = new Set(process.argv.slice(2));
const selected = selectedNames.size
  ? cases.filter((entry) => selectedNames.has(entry.name))
  : cases;
if (selectedNames.size && selected.length !== selectedNames.size) {
  const known = cases.map((entry) => entry.name).join(", ");
  throw new Error(`Unknown benchmark name. Known names: ${known}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  samples: SAMPLES,
  sizes: SIZES,
  benchmarks: selected.map((entry) => {
    const points = SIZES.map((n) => benchmark(entry, n));
    console.log(`${entry.name}: ${points.map((point) => `${point.n}=${point.sqlCount} SQL/${point.p50Ms}ms`).join("; ")}`);
    return { name: entry.name, unit: entry.unit, points };
  }),
};

writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${OUTPUT_PATH}`);
