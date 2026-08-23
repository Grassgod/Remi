import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { decryptScmCredential, encryptScmCredential } from "@multiremi/scm/credentials.js";
import { reconcileObservation } from "@multiremi/scm/reconcile.js";
import { scmIngestionStore } from "@multiremi/scm/store.js";
import { ScmWebhookIngestor } from "@multiremi/scm/webhook.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const previousScmKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const previousAllowedApiHosts = process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS;
const previousMultiremiToken = process.env.MULTIREMI_TOKEN;
const previousScmPreviousKeys = process.env.MULTIREMI_SCM_ENCRYPTION_PREVIOUS_KEYS;

afterEach(() => {
  resetMultiremiTestEnv();
  if (previousScmKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = previousScmKey;
  if (previousAllowedApiHosts === undefined) delete process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS;
  else process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = previousAllowedApiHosts;
  if (previousMultiremiToken === undefined) delete process.env.MULTIREMI_TOKEN;
  else process.env.MULTIREMI_TOKEN = previousMultiremiToken;
  if (previousScmPreviousKeys === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_PREVIOUS_KEYS;
  else process.env.MULTIREMI_SCM_ENCRYPTION_PREVIOUS_KEYS = previousScmPreviousKeys;
});

function seedConnection() {
  process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const store = createLocalStore();
  store.updateWorkspace("local", {
    repos: [{
      id: "repo_widgets",
      name: "widgets",
      url: "git@github.com:acme/widgets.git",
      source: "github",
      default_branch: "main",
    }],
  });
  const connection = store.createScmConnection({
    workspaceId: "local",
    name: "GitHub production",
    provider: "github",
    mode: "hybrid",
    accessToken: "ghp_private-token",
    webhookSecret: "webhook-private-secret",
    repositoryIds: ["repo_widgets"],
  });
  return { store, connection };
}

function recordChange(
  store: ReturnType<typeof createLocalStore>,
  connectionId: string,
  input: {
    logicalKey: string;
    source?: "poll" | "webhook";
    fidelity?: "exact" | "inferred";
    occurredAt?: string;
    observedAt?: string;
  },
) {
  return store.recordScmCanonicalEvent({
    workspaceId: "local",
    connectionId,
    repositoryId: "repo_widgets",
    type: "change.merged",
    subjectType: "change_request",
    subjectId: "42",
    logicalKey: input.logicalKey,
    fidelity: input.fidelity ?? "inferred",
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    payload: { id: "provider-change-42", number: 42, branch: "main", mergeSha: "abc" },
    evidence: {
      source: input.source ?? "poll",
      dedupeKey: `${input.source ?? "poll"}:${input.logicalKey}`,
      providerEventId: input.source === "webhook" ? "delivery-42" : null,
    },
  });
}

describe("SCM connection and canonical event store", () => {
  it("encrypts credentials and never includes plaintext in connection responses", () => {
    const { store, connection } = seedConnection();
    expect(connection.accessTokenSet).toBe(true);
    expect(connection.accessTokenHint).toBe("oken");
    expect(connection.webhookSecretSet).toBe(true);
    expect(connection.repositories).toHaveLength(1);
    expect(connection.repositories[0]?.repositoryUrl).toBe("git@github.com:acme/widgets.git");
    expect(connection.repositories[0]?.owner).toBe("acme");
    expect(connection.repositories[0]?.name).toBe("widgets");
    expect(connection.repositories[0]?.externalId).toBeNull();
    expect(JSON.stringify(connection)).not.toContain("ghp_private-token");
    expect(store.getScmConnectionCredential(connection.id)).toEqual({
      accessToken: "ghp_private-token",
      webhookSecret: "webhook-private-secret",
    });

    const row = db!.query(
      "SELECT access_token_encrypted, webhook_secret_encrypted FROM multiremi_scm_connections WHERE id = ?",
    ).get(connection.id) as Record<string, string>;
    expect(row.access_token_encrypted).not.toContain("ghp_private-token");
    expect(row.webhook_secret_encrypted).not.toContain("webhook-private-secret");
  });

  it("decrypts credentials after encryption-key precedence changes", () => {
    delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
    process.env.MULTIREMI_TOKEN = "old-deployment-token";
    const context = { workspaceId: "local", connectionId: "scm_rotation", field: "access_token" as const };
    const v2 = encryptScmCredential("secret-token", context);
    const [, , iv, tag, body] = v2.split(".");
    const legacyV1 = ["v1", iv, tag, body].join(".");

    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    expect(decryptScmCredential(v2, context)).toBe("secret-token");
    expect(decryptScmCredential(legacyV1, context)).toBe("secret-token");
  });

  it("rotates dedicated encryption keys through an explicit previous-key ring", () => {
    delete process.env.MULTIREMI_TOKEN;
    const oldKey = Buffer.alloc(32, 12).toString("base64");
    const newKey = Buffer.alloc(32, 13).toString("base64");
    const context = { workspaceId: "local", connectionId: "scm_rotation", field: "webhook_secret" as const };
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = oldKey;
    const ciphertext = encryptScmCredential("rotating-secret", context);

    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = newKey;
    process.env.MULTIREMI_SCM_ENCRYPTION_PREVIOUS_KEYS = oldKey;
    expect(decryptScmCredential(ciphertext, context)).toBe("rotating-secret");

    delete process.env.MULTIREMI_SCM_ENCRYPTION_PREVIOUS_KEYS;
    expect(() => decryptScmCredential(ciphertext, context)).toThrow("could not be decrypted");
  });

  it("uses the Codebase action API as the default API endpoint", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const store = createLocalStore();
    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "Codebase",
      provider: "codebase",
      mode: "poll",
    });
    expect(connection.baseUrl).toBe("https://code.byted.org");
    expect(connection.apiBaseUrl).toBe("https://codebase-api.byted.org/v2");
  });

  it("makes the first provider-origin connection the default and binds every matching repository", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
    const store = createLocalStore();
    store.updateWorkspace("local", {
      repos: [
        { id: "repo_one", name: "one", url: "git@github.com:acme/one.git", source: "github", default_branch: "main" },
        { id: "repo_two", name: "two", url: "https://github.com/acme/two.git", source: "github", default_branch: "trunk" },
        { id: "repo_internal", name: "internal", url: "git@code.byted.org:acme/internal.git", source: "codebase", default_branch: "main" },
      ],
    });

    const defaultConnection = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub default",
      provider: "github",
      mode: "poll",
    });
    expect(defaultConnection.repositoryScope).toBe("all");
    expect(defaultConnection.isDefault).toBe(true);
    expect(defaultConnection.repositories.map((binding) => binding.repositoryId)).toEqual(["repo_one", "repo_two"]);
    expect(defaultConnection.repositories.every((binding) => binding.assignmentOrigin === "default")).toBe(true);

    const selectedConnection = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub selected",
      provider: "github",
      mode: "poll",
    });
    expect(selectedConnection.repositoryScope).toBe("selected");
    expect(selectedConnection.isDefault).toBe(false);
    expect(selectedConnection.repositories).toEqual([]);

    store.updateWorkspace("local", {
      repos: [
        ...store.getWorkspace("local")!.repos,
        { id: "repo_future", name: "future", url: "git@github.com:acme/future.git", source: "github", default_branch: "main" },
      ],
    });
    store.reconcileScmRepositoryBindings("local");
    expect(store.getScmRepositoryBinding(defaultConnection.id, "repo_future")?.assignmentOrigin).toBe("default");
    expect(store.getScmRepositoryBinding(selectedConnection.id, "repo_future")).toBeNull();
  });

  it("normalizes repository site URLs to one origin before selecting a default connection", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
    const store = createLocalStore();
    const first = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub default",
      provider: "github",
      mode: "poll",
      baseUrl: "https://github.com/acme/widgets",
    });
    expect(first.baseUrl).toBe("https://github.com");
    expect(() => store.createScmConnection({
      workspaceId: "local",
      name: "Duplicate origin",
      provider: "github",
      mode: "poll",
      baseUrl: "https://github.com/another/path",
      repositoryScope: "all",
    })).toThrow("default connection already exists");
  });

  it("requires an explicit atomic transfer and clears stale polling state", () => {
    const { store, connection } = seedConnection();
    const selected = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub secondary",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
    });
    store.upsertScmSyncCursor({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "default_branch",
      baselineCompletedAt: "2026-08-21T00:00:00.000Z",
    });
    store.upsertScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "ref",
      externalId: "main",
      contentHash: "old",
      payload: { head_sha: "old" },
    });
    const issue = store.createIssue({ title: "Transferred projection", workspaceId: "local" });
    store.upsertScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "41",
      contentHash: "change-old",
      payload: {
        number: 41,
        title: `${issue.key} transferred projection`,
        state: "open",
        source_branch: "feature/transfer",
        target_branch: "main",
      },
    });
    expect((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_change_requests WHERE connection_id = ? AND repository_id = ?",
    ).get(connection.id, "repo_widgets") as { count: number }).count).toBe(1);
    expect((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_issue_links WHERE issue_id = ?",
    ).get(issue.id) as { count: number }).count).toBe(1);

    const move = {
      workspaceId: "local",
      connectionId: selected.id,
      repositoryId: "repo_widgets",
      repositoryUrl: "git@github.com:acme/widgets.git",
      repositorySource: "github" as const,
      name: "widgets",
      defaultBranch: "main",
      assignmentOrigin: "explicit" as const,
    };
    expect(() => store.upsertScmRepositoryBinding(move)).toThrow("transfer=true");
    expect(store.getScmRepositoryBinding(connection.id, "repo_widgets")).not.toBeNull();

    const transferred = store.upsertScmRepositoryBinding({ ...move, transfer: true });
    expect(transferred.connectionId).toBe(selected.id);
    expect(transferred.assignmentOrigin).toBe("explicit");
    expect(store.getScmSyncCursor(connection.id, "repo_widgets", "default_branch")).toBeNull();
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "ref", "main")).toBeNull();
    expect((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_change_requests WHERE connection_id = ? AND repository_id = ?",
    ).get(connection.id, "repo_widgets") as { count: number }).count).toBe(0);
    expect((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_change_requests WHERE connection_id = ? AND repository_id = ?",
    ).get(selected.id, "repo_widgets") as { count: number }).count).toBe(1);
    expect((db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_issue_links WHERE issue_id = ?",
    ).get(issue.id) as { count: number }).count).toBe(1);
  });

  it("atomically transfers explicitly selected repositories while creating a connection", () => {
    const { store, connection } = seedConnection();

    const selected = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub selected",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
      repositoryIds: ["repo_widgets"],
    });

    expect(selected.repositories).toContainEqual(
      expect.objectContaining({
        repositoryId: "repo_widgets",
        assignmentOrigin: "explicit",
      }),
    );
    expect(store.getScmRepositoryBinding(connection.id, "repo_widgets")).toBeNull();
    expect(store.getScmRepositoryBinding(selected.id, "repo_widgets")?.connectionId).toBe(selected.id);
  });

  it("atomically replaces selected repository bindings and transfers ownership", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 35).toString("base64");
    const store = createLocalStore();
    store.updateWorkspace("local", {
      repos: [
        { id: "repo_one", name: "one", url: "git@github.com:acme/one.git", source: "github", default_branch: "main" },
        { id: "repo_two", name: "two", url: "git@github.com:acme/two.git", source: "github", default_branch: "main" },
      ],
    });
    const first = store.createScmConnection({
      workspaceId: "local",
      name: "First selected",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
      repositoryIds: ["repo_one"],
    });
    const second = store.createScmConnection({
      workspaceId: "local",
      name: "Second selected",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
      repositoryIds: ["repo_two"],
    });
    store.upsertScmSyncCursor({
      connectionId: second.id,
      repositoryId: "repo_two",
      stream: "change_requests",
      baselineCompletedAt: "2026-08-21T00:00:00.000Z",
    });

    const updated = store.updateScmConnection(second.id, { repositoryIds: ["repo_one"] });

    expect(updated.repositories.map((binding) => binding.repositoryId)).toEqual(["repo_one"]);
    expect(updated.repositories[0]?.assignmentOrigin).toBe("explicit");
    expect(store.getScmRepositoryBinding(first.id, "repo_one")).toBeNull();
    expect(store.getScmRepositoryBinding(second.id, "repo_two")).toBeNull();
    expect(store.getScmSyncCursor(second.id, "repo_two", "change_requests")).toBeNull();
  });

  it("rolls back the whole connection update when selected binding replacement fails", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 36).toString("base64");
    const store = createLocalStore();
    store.updateWorkspace("local", {
      repos: [
        { id: "repo_one", name: "one", url: "git@github.com:acme/one.git", source: "github", default_branch: "main" },
        { id: "repo_two", name: "two", url: "git@github.com:acme/two.git", source: "github", default_branch: "main" },
      ],
    });
    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "Stable selected",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
      repositoryIds: ["repo_one"],
    });
    db!.exec(`
      CREATE TRIGGER fail_selected_binding_replace
      BEFORE INSERT ON multiremi_scm_repository_bindings
      WHEN NEW.repository_id = 'repo_two'
      BEGIN
        SELECT RAISE(ABORT, 'injected selected binding failure');
      END
    `);

    expect(() => store.updateScmConnection(connection.id, {
      name: "Must roll back",
      repositoryIds: ["repo_one", "repo_two"],
    })).toThrow("injected selected binding failure");
    expect(store.getScmConnection(connection.id)?.name).toBe("Stable selected");
    expect(store.listScmRepositoryBindings({ connectionId: connection.id }).map((binding) => binding.repositoryId))
      .toEqual(["repo_one"]);
  });

  it("moves only default-origin bindings when selecting a new default connection", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 16).toString("base64");
    const store = createLocalStore();
    store.updateWorkspace("local", {
      repos: [
        { id: "repo_default", name: "default", url: "git@github.com:acme/default.git", source: "github" },
        { id: "repo_explicit", name: "explicit", url: "git@github.com:acme/explicit.git", source: "github" },
      ],
    });
    const first = store.createScmConnection({ workspaceId: "local", name: "First", provider: "github", mode: "poll" });
    const second = store.createScmConnection({
      workspaceId: "local",
      name: "Second",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
    });
    store.upsertScmRepositoryBinding({
      workspaceId: "local",
      connectionId: first.id,
      repositoryId: "repo_explicit",
      repositoryUrl: "git@github.com:acme/explicit.git",
      repositorySource: "github",
      name: "explicit",
      assignmentOrigin: "explicit",
    });

    const promoted = store.updateScmConnection(second.id, { repositoryScope: "all" });
    expect(promoted.isDefault).toBe(true);
    expect(store.getScmConnection(first.id)).toMatchObject({ repositoryScope: "selected", isDefault: false });
    expect(store.getScmRepositoryBinding(second.id, "repo_default")?.assignmentOrigin).toBe("default");
    expect(store.getScmRepositoryBinding(first.id, "repo_explicit")?.assignmentOrigin).toBe("explicit");
  });

  it("requires a webhook secret exactly when the connection mode consumes webhooks", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const store = createLocalStore();

    expect(() => store.createScmConnection({
      workspaceId: "local",
      name: "Missing webhook secret",
      provider: "github",
      mode: "webhook",
    })).toThrow("webhook secret is required");
    expect(() => store.createScmConnection({
      workspaceId: "local",
      name: "Blank hybrid secret",
      provider: "github",
      mode: "hybrid",
      webhookSecret: "   ",
    })).toThrow("webhook secret is required");

    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "Polling only",
      provider: "github",
      mode: "poll",
      webhookSecret: "",
    });
    expect(connection.webhookSecretSet).toBe(false);
    expect(() => store.updateScmConnection(connection.id, { mode: "webhook" }))
      .toThrow("webhook secret is required");

    const enabled = store.updateScmConnection(connection.id, {
      mode: "hybrid",
      webhookSecret: "new-webhook-secret",
    });
    expect(enabled.webhookSecretSet).toBe(true);
    const preserved = store.updateScmConnection(connection.id, { webhookSecret: "  " });
    expect(preserved.webhookSecretSet).toBe(true);
    expect(store.getScmConnectionCredential(connection.id)?.webhookSecret).toBe("new-webhook-secret");
    expect(() => store.updateScmConnection(connection.id, { clearWebhookSecret: true }))
      .toThrow("webhook secret is required");

    const cleared = store.updateScmConnection(connection.id, { mode: "poll", clearWebhookSecret: true });
    expect(cleared.webhookSecretSet).toBe(false);
    expect(store.getScmConnectionCredential(connection.id)?.webhookSecret).toBeNull();
  });

  it("requires an explicit allowlist for enterprise API hosts", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createLocalStore();
    expect(() => store.createScmConnection({
      workspaceId: "local",
      name: "Enterprise GitHub",
      provider: "github",
      mode: "poll",
      baseUrl: "https://github.enterprise.example",
    })).toThrow("MULTIREMI_SCM_ALLOWED_API_HOSTS");

    process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = "github.enterprise.example";
    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "Enterprise GitHub",
      provider: "github",
      mode: "poll",
      baseUrl: "https://github.enterprise.example",
    });
    expect(connection.apiBaseUrl).toBe("https://github.enterprise.example/api/v3");
  });

  it("rejects private API hosts unless they are explicitly allowed", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");
    const store = createLocalStore();
    expect(() => store.createScmConnection({
      workspaceId: "local",
      name: "Unsafe",
      provider: "github",
      mode: "poll",
      baseUrl: "https://10.0.0.1",
      apiBaseUrl: "https://10.0.0.1/api/v3",
    })).toThrow("loopback or link-local");
  });

  it("rejects repository sources that do not match the connection provider atomically", () => {
    const { store } = seedConnection();
    expect(() => store.createScmConnection({
      workspaceId: "local",
      name: "Wrong provider",
      provider: "codebase",
      mode: "poll",
      repositoryIds: ["repo_widgets"],
    })).toThrow("does not match SCM connection provider");
    expect(store.listScmConnections({ provider: "codebase" })).toEqual([]);
  });

  it("binds unknown-source repositories only when their remote matches the connection", () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString("base64");
    const store = createLocalStore();
    store.updateWorkspace("local", {
      repos: [
        { id: "repo_https", name: "https", url: "https://github.com/acme/https.git", source: "unknown" },
        { id: "repo_ssh", name: "ssh", url: "git@github.com:acme/ssh.git", source: "unknown" },
        { id: "repo_evil", name: "evil", url: "https://evil.example/acme/widgets.git", source: "unknown" },
      ],
    });
    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "poll",
      repositoryScope: "selected",
    });

    expect(store.upsertScmRepositoryBinding({
      workspaceId: "local",
      connectionId: connection.id,
      repositoryId: "repo_https",
      repositoryUrl: "https://github.com/acme/https.git",
      repositorySource: "unknown",
      name: "https",
    }).repositoryId).toBe("repo_https");
    expect(store.upsertScmRepositoryBinding({
      workspaceId: "local",
      connectionId: connection.id,
      repositoryId: "repo_ssh",
      repositoryUrl: "git@github.com:acme/ssh.git",
      repositorySource: "unknown",
      name: "ssh",
    }).repositoryId).toBe("repo_ssh");
    expect(() => store.upsertScmRepositoryBinding({
      workspaceId: "local",
      connectionId: connection.id,
      repositoryId: "repo_evil",
      repositoryUrl: "https://evil.example/acme/widgets.git",
      repositorySource: "unknown",
      name: "evil",
    })).toThrow("HTTPS origin does not match");
    expect(store.getScmRepositoryBinding(connection.id, "repo_evil")).toBeNull();
  });

  it("rejects connection base URL changes that would orphan existing bindings", () => {
    const { store, connection } = seedConnection();
    process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = "github.enterprise.example";
    expect(() => store.updateScmConnection(connection.id, {
      baseUrl: "https://github.enterprise.example",
      apiBaseUrl: "https://github.enterprise.example/api/v3",
    })).toThrow("SSH host does not match");
    expect(store.getScmConnection(connection.id)?.baseUrl).toBe("https://github.com");
  });

  it("explicitly cleans baseline state when deleting a connection without event history", () => {
    const { store, connection } = seedConnection();
    const issue = store.createIssue({ title: "Delete projection", workspaceId: "local" });
    expect(store.deleteScmRepositoryBinding(connection.id, "repo_missing")).toBe(false);
    store.upsertScmSyncCursor({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "default_branch",
      baselineCompletedAt: "2026-08-21T00:00:00.000Z",
    });
    store.upsertScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "ref",
      externalId: "main",
      contentHash: "hash",
      payload: { head_sha: "abc" },
    });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "delete-1",
      contentHash: "delete-projection",
      payload: { number: 1, title: `${issue.key} cleanup`, state: "open" },
    });
    expect(store.listScmChangeRequestsForIssue(issue.id)).toHaveLength(1);
    expect(store.deleteScmConnection(connection.id)).toBe(true);
    expect(store.getScmSyncCursor(connection.id, "repo_widgets", "default_branch")).toBeNull();
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "ref", "main")).toBeNull();
    expect(store.listScmRepositoryBindings({ connectionId: connection.id })).toEqual([]);
    expect(store.listScmChangeRequestsForIssue(issue.id)).toEqual([]);
  });

  it("claims polling streams with fencing tokens and rejects stale owners", () => {
    const { store, connection } = seedConnection();
    const first = store.claimScmSyncStream({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      owner: "server-a",
      now: "2026-08-21T00:00:00.000Z",
      leaseMs: 60_000,
    });
    expect(first?.leaseOwner).toBe("server-a");
    expect(first?.leaseToken).toBeTruthy();
    expect(store.claimScmSyncStream({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      owner: "server-b",
      now: "2026-08-21T00:00:30.000Z",
    })).toBeNull();
    expect(store.updateClaimedScmSyncCursor({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      leaseToken: "stale-token",
      watermark: "2026-08-21T00:00:20.000Z",
    })).toBeNull();
    expect(store.updateClaimedScmSyncCursor({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      leaseToken: first!.leaseToken!,
      watermark: "2026-08-21T00:00:20.000Z",
    })?.watermark).toBe("2026-08-21T00:00:20.000Z");
    expect(store.releaseScmSyncStream({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      leaseToken: "stale-token",
    })).toBe(false);
    expect(store.releaseScmSyncStream({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      leaseToken: first!.leaseToken!,
    })).toBe(true);
    expect(store.claimScmSyncStream({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      stream: "change_requests",
      owner: "server-b",
      now: "2026-08-21T00:00:31.000Z",
    })?.leaseOwner).toBe("server-b");
  });

  it("does not let an older provider revision overwrite a newer snapshot", () => {
    const { store, connection } = seedConnection();
    const newer = store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      version: "v2",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v2",
      contentHash: "new",
      payload: { state: "merged" },
      observedAt: "2026-08-21T10:00:01.000Z",
    });
    const stale = store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      version: "v1",
      revisionAt: "2026-08-21T09:00:00.000Z",
      revision: "v1",
      contentHash: "old",
      payload: { state: "open" },
      observedAt: "2026-08-21T10:00:02.000Z",
    });
    expect(newer.applied).toBe(true);
    expect(stale.applied).toBe(false);
    expect(stale.snapshot.payload.state).toBe("merged");
  });

  it("rolls back a polling snapshot and projection when canonical event persistence fails", () => {
    const { store, connection } = seedConnection();
    const binding = connection.repositories[0]!;
    const workspaceEvents: string[] = [];
    store.onWorkspaceEvent((event) => workspaceEvents.push(event.type));
    const observation = {
      stream: "change_requests" as const,
      entityType: "change_request" as const,
      externalId: "atomic-42",
      version: "v1",
      occurredAt: "2026-08-21T10:00:00.000Z",
      observedAt: "2026-08-21T10:00:01.000Z",
      payload: {
        number: 42,
        title: "Atomic polling transition",
        state: "open",
        source_branch: "feature/atomic",
        target_branch: "main",
        updated_at: "2026-08-21T10:00:00.000Z",
      },
    };
    db!.exec(`
      CREATE TRIGGER fail_atomic_scm_event
      BEFORE INSERT ON multiremi_scm_events
      BEGIN
        SELECT RAISE(ABORT, 'injected canonical event failure');
      END
    `);

    expect(() => reconcileObservation({
      store: scmIngestionStore(store),
      binding,
      observation,
      baseline: false,
    })).toThrow("injected canonical event failure");
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "change_request", "atomic-42")).toBeNull();
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_change_requests WHERE connection_id = ? AND external_id = ?",
    ).get(connection.id, "atomic-42")).toEqual({ count: 0 });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_events").get()).toEqual({ count: 0 });
    expect(workspaceEvents).toEqual([]);

    db!.exec("DROP TRIGGER fail_atomic_scm_event");
    const retried = reconcileObservation({
      store: scmIngestionStore(store),
      binding,
      observation,
      baseline: false,
    });
    expect(retried.changed).toBe(true);
    expect(retried.events).toHaveLength(1);
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "change_request", "atomic-42")?.version).toBe("v1");
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_change_requests WHERE connection_id = ? AND external_id = ?",
    ).get(connection.id, "atomic-42")).toEqual({ count: 1 });
    expect(workspaceEvents).toEqual(["change_request:updated"]);
  });

  it("atomically rolls back webhook snapshots and deduplicates a retried delivery", () => {
    const { store, connection } = seedConnection();
    const ingestor = new ScmWebhookIngestor(scmIngestionStore(store));
    const body = {
      action: "opened",
      repository: { id: 101, name: "widgets", owner: { login: "acme" }, default_branch: "main" },
      pull_request: {
        id: 9001,
        number: 42,
        title: "Atomic webhook",
        state: "open",
        merged: false,
        created_at: "2026-08-21T10:00:00.000Z",
        updated_at: "2026-08-21T10:00:00.000Z",
        head: { ref: "feature/atomic-webhook", sha: "abc" },
        base: { ref: "main", sha: "def" },
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", "webhook-private-secret").update(rawBody).digest("hex");
    const delivery = {
      connectionId: connection.id,
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-atomic-42",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      rawBody,
      body,
      observedAt: "2026-08-21T10:00:01.000Z",
    };
    db!.exec(`
      CREATE TRIGGER fail_atomic_webhook_event
      BEFORE INSERT ON multiremi_scm_events
      BEGIN
        SELECT RAISE(ABORT, 'injected webhook event failure');
      END
    `);

    expect(() => ingestor.ingest(delivery)).toThrow("injected webhook event failure");
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "change_request", "9001")).toBeNull();
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_change_requests").get()).toEqual({ count: 0 });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_events").get()).toEqual({ count: 0 });

    db!.exec("DROP TRIGGER fail_atomic_webhook_event");
    const first = ingestor.ingest(delivery);
    const duplicate = ingestor.ingest(delivery);
    expect(first.events[0]).toMatchObject({ created: true, evidenceCreated: true });
    expect(duplicate.events[0]).toMatchObject({ created: false, evidenceCreated: false });
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "change_request", "9001")?.payload)
      .toMatchObject({ title: "Atomic webhook", state: "open" });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_entity_snapshots").get()).toEqual({ count: 1 });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_events").get()).toEqual({ count: 1 });
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_event_evidence").get()).toEqual({ count: 1 });
  });

  it("projects baseline change requests and auto-links issue keys from title, branch, or body", () => {
    const { store, connection } = seedConnection();
    const issue = store.createIssue({ title: "Projection target", workspaceId: "local" });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      version: "v1",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "open-v1",
      payload: {
        number: 42,
        title: "Update projection",
        body: `Resolves ${issue.key}`,
        state: "open",
        source_branch: "feature/projection",
        target_branch: "main",
        author: "octocat",
        updated_at: "2026-08-21T10:00:00.000Z",
      },
    });

    expect(store.listScmChangeRequestsForIssue(issue.id)).toEqual([
      expect.objectContaining({
        provider: "github",
        externalId: "42",
        number: 42,
        body: `Resolves ${issue.key}`,
        sourceBranch: "feature/projection",
        targetBranch: "main",
        author: "octocat",
      }),
    ]);
    expect(events.filter((event) => event.type === "change_request:updated")).toHaveLength(1);
    expect(events.find((event) => event.type === "change_request:updated")?.payload).toMatchObject({
      issue_ids: [issue.id],
    });
  });

  it("keeps a manual unlink suppressed across later auto-link projection updates", () => {
    const { store, connection } = seedConnection();
    const issue = store.createIssue({ title: "Manual unlink", workspaceId: "local" });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "v1",
      payload: { number: 42, title: `${issue.key} first`, state: "open" },
    });
    const changeRequest = store.listScmChangeRequestsForIssue(issue.id)![0]!;
    expect(store.unlinkScmChangeRequestFromIssue(issue.id, changeRequest.id)).toBe(true);

    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      revisionAt: "2026-08-21T10:01:00.000Z",
      revision: "v2",
      contentHash: "v2",
      payload: { number: 42, title: `${issue.key} still present`, state: "open" },
    });
    expect(store.listScmChangeRequestsForIssue(issue.id)).toEqual([]);
    expect(store.linkScmChangeRequestToIssue(issue.id, changeRequest.id).link.source).toBe("manual");
    expect(store.listScmChangeRequestsForIssue(issue.id)).toHaveLength(1);
  });

  it("completes linked issues through the standard lifecycle once when enabled", () => {
    const { store, connection } = seedConnection();
    store.updateWorkspace("local", {
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    const issue = store.createIssue({ title: "Complete after merge", workspaceId: "local" });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "v1",
      payload: { number: 42, title: `${issue.key} merge`, state: "merged" },
    });

    const first = recordChange(store, connection.id, { logicalKey: "change.merged:42:lifecycle" });
    const duplicate = recordChange(store, connection.id, {
      logicalKey: "change.merged:42:lifecycle",
      source: "webhook",
      fidelity: "exact",
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(store.getIssue(issue.id)?.status).toBe("done");
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_system_events WHERE resource_id = ? AND event = 'status_changed'",
    ).get(issue.id)).toEqual({ count: 1 });
    expect(db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_scm_effects WHERE issue_id = ? AND status = 'applied'",
    ).get(issue.id)).toEqual({ count: 1 });
  });

  it("keeps merge completion retryable after a transient lifecycle failure", () => {
    const { store, connection } = seedConnection();
    store.updateWorkspace("local", {
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    const issue = store.createIssue({ title: "Retry merge completion", workspaceId: "local" });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "v1",
      payload: { number: 42, title: `${issue.key} retry merge`, state: "merged" },
    });
    db!.exec(`
      CREATE TRIGGER fail_merge_completion
      BEFORE UPDATE OF status ON multiremi_issues
      WHEN NEW.status = 'done'
      BEGIN
        SELECT RAISE(ABORT, 'transient merge completion failure');
      END
    `);

    const recorded = recordChange(store, connection.id, { logicalKey: "change.merged:42:retry" });
    const firstDispatchAt = new Date(Date.now() + 1_000);
    expect(store.dispatchPendingScmEvents(firstDispatchAt)).toEqual([]);
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(store.getScmCanonicalEvent(recorded.event.id)?.status).toBe("pending");
    expect(db!.query(
      "SELECT status, last_error FROM multiremi_scm_effects WHERE event_id = ?",
    ).get(recorded.event.id)).toEqual({
      status: "pending",
      last_error: "transient merge completion failure",
    });

    db!.exec("DROP TRIGGER fail_merge_completion");
    expect(store.dispatchPendingScmEvents(new Date(firstDispatchAt.getTime() + 60_000))).toEqual([]);
    expect(store.getIssue(issue.id)?.status).toBe("done");
    expect(store.getScmCanonicalEvent(recorded.event.id)?.status).toBe("processed");
  });

  it("does not replay merge completion when the setting is enabled after event history exists", () => {
    const { store, connection } = seedConnection();
    const issue = store.createIssue({ title: "Historical merge", workspaceId: "local" });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "v1",
      payload: { number: 42, title: `${issue.key} history`, state: "merged" },
    });
    recordChange(store, connection.id, { logicalKey: "change.merged:42:history" });
    expect(store.getIssue(issue.id)?.status).toBe("todo");

    store.updateWorkspace("local", {
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    recordChange(store, connection.id, {
      logicalKey: "change.merged:42:history",
      source: "webhook",
      fidelity: "exact",
    });
    expect(store.getIssue(issue.id)?.status).toBe("todo");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_scm_effects").get()).toEqual({ count: 0 });
  });

  it("deduplicates poll and webhook evidence into one canonical event", () => {
    const { store, connection } = seedConnection();
    const inferred = recordChange(store, connection.id, { logicalKey: "change.merged:42:abc" });
    const exact = recordChange(store, connection.id, {
      logicalKey: "change.merged:42:abc",
      source: "webhook",
      fidelity: "exact",
    });
    const duplicate = recordChange(store, connection.id, {
      logicalKey: "change.merged:42:abc",
      source: "webhook",
      fidelity: "exact",
    });

    expect(inferred.created).toBe(true);
    expect(exact.created).toBe(false);
    expect(exact.evidenceCreated).toBe(true);
    expect(duplicate.evidenceCreated).toBe(false);
    expect(store.getScmCanonicalEvent(inferred.event.id)?.fidelity).toBe("exact");
    expect(store.listScmEventEvidence(inferred.event.id).map((evidence) => evidence.source).sort()).toEqual(["poll", "webhook"]);
  });

  it("does not deliver history to a newly-created automation and dispatches each new event once", () => {
    const { store, connection } = seedConnection();
    const historical = recordChange(store, connection.id, {
      logicalKey: "change.merged:40:old",
      observedAt: "2020-01-01T00:00:00.000Z",
    });
    const agent = store.createAgent({ name: "Wiki Maintainer", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Update repository wiki",
      description: "Rebuild the affected wiki pages",
      workspaceId: "local",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["change.merged"],
        repositoryIds: ["repo_widgets"],
        branch: "main",
      },
    });

    expect(store.dispatchPendingScmEvents()).toEqual([]);
    expect(store.getScmCanonicalEvent(historical.event.id)?.status).toBe("processed");
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(0);

    const delayed = recordChange(store, connection.id, {
      logicalKey: "change.merged:41:delayed",
      occurredAt: "2020-01-02T00:00:00.000Z",
      observedAt: new Date(Date.now() + 500).toISOString(),
    });
    expect(store.dispatchPendingScmEvents(new Date(Date.now() + 1_000))).toEqual([]);
    expect(store.getScmCanonicalEvent(delayed.event.id)?.status).toBe("processed");

    const current = recordChange(store, connection.id, {
      logicalKey: "change.merged:42:new",
      observedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const runs = store.dispatchPendingScmEvents(new Date(Date.now() + 2_000));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "scm_event", triggerId: trigger.id, eventId: current.event.id });
    expect(runs[0]?.payload).toEqual({
      event: expect.objectContaining({ id: current.event.id, type: "change.merged", repositoryId: "repo_widgets" }),
      data: expect.objectContaining({ id: "provider-change-42", branch: "main" }),
    });
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);

    db!.run(
      "UPDATE multiremi_scm_events SET status = 'pending', processed_at = NULL, available_at = ? WHERE id = ?",
      [new Date(Date.now() - 1_000).toISOString(), current.event.id],
    );
    expect(store.dispatchPendingScmEvents()).toEqual([]);
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);
  });

  it("retries the persisted delivery set after filters change and explicitly skips disabled triggers", () => {
    const { store, connection } = seedConnection();
    const agent = store.createAgent({ name: "Wiki Maintainer", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Update repository wiki",
      workspaceId: "local",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: { resource: "scm", events: ["change.merged"], repositoryIds: ["repo_widgets"] },
    });
    const internals = store as unknown as {
      autopilots: { runAutopilot: typeof store.runAutopilot };
    };
    const originalRun = internals.autopilots.runAutopilot;
    const firstObservedAt = new Date(Date.now() + 1_000).toISOString();
    const first = recordChange(store, connection.id, {
      logicalKey: "change.merged:51:retry",
      observedAt: firstObservedAt,
    });
    internals.autopilots.runAutopilot = () => {
      throw new Error("temporary scheduler failure");
    };
    expect(store.dispatchPendingScmEvents(new Date(Date.parse(firstObservedAt) + 1_000))).toEqual([]);
    store.updateAutopilotTrigger(autopilot.id, trigger.id, {
      eventConfig: { resource: "scm", events: ["change.closed"], repositoryIds: ["repo_widgets"] },
    });
    internals.autopilots.runAutopilot = originalRun;
    expect(store.dispatchPendingScmEvents(new Date(Date.parse(firstObservedAt) + 10_000))).toHaveLength(1);
    expect(store.getScmCanonicalEvent(first.event.id)?.status).toBe("processed");

    store.updateAutopilotTrigger(autopilot.id, trigger.id, {
      eventConfig: { resource: "scm", events: ["change.merged"], repositoryIds: ["repo_widgets"] },
    });
    const secondObservedAt = new Date(Date.parse(firstObservedAt) + 20_000).toISOString();
    const second = recordChange(store, connection.id, {
      logicalKey: "change.merged:52:disable",
      observedAt: secondObservedAt,
    });
    internals.autopilots.runAutopilot = () => {
      throw new Error("temporary scheduler failure");
    };
    expect(store.dispatchPendingScmEvents(new Date(Date.parse(secondObservedAt) + 1_000))).toEqual([]);
    store.updateAutopilotTrigger(autopilot.id, trigger.id, { enabled: false });
    internals.autopilots.runAutopilot = originalRun;
    expect(store.dispatchPendingScmEvents(new Date(Date.parse(secondObservedAt) + 10_000))).toEqual([]);
    expect(store.getScmCanonicalEvent(second.event.id)?.status).toBe("processed");
    const delivery = db!.query(
      "SELECT status, last_error FROM multiremi_scm_event_deliveries WHERE event_id = ?",
    ).get(second.event.id) as { status: string; last_error: string };
    expect(delivery.status).toBe("skipped");
    expect(delivery.last_error).toContain("trigger is disabled");
  });

  it("dispatches GitHub Actions pipeline events only to matching branch filters", () => {
    const { store, connection } = seedConnection();
    const agent = store.createAgent({ name: "Pipeline Agent", provider: "codex" });
    const main = store.createAutopilot({
      title: "Main pipeline",
      workspaceId: "local",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const feature = store.createAutopilot({
      title: "Feature pipeline",
      workspaceId: "local",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    store.createAutopilotTrigger(main.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["pipeline.completed"],
        repositoryIds: ["repo_widgets"],
        branch: "main",
      },
    });
    store.createAutopilotTrigger(feature.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["pipeline.completed"],
        repositoryIds: ["repo_widgets"],
        branch: "feature/wiki",
      },
    });

    const observedAt = new Date(Date.now() + 1_000);
    store.recordScmCanonicalEvent({
      workspaceId: "local",
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      type: "pipeline.completed",
      subjectType: "pipeline",
      subjectId: "workflow_run:501:2",
      logicalKey: "pipeline.completed:repo_widgets:workflow_run:501:2:success",
      fidelity: "exact",
      occurredAt: observedAt.toISOString(),
      observedAt: observedAt.toISOString(),
      payload: { id: 501, kind: "workflow_run", attempt: 2, branch: "main", conclusion: "success" },
      evidence: { source: "webhook", dedupeKey: "webhook:delivery-workflow" },
    });

    const runs = store.dispatchPendingScmEvents(new Date(observedAt.getTime() + 1_000));
    expect(runs.map((run) => run.autopilotId)).toEqual([main.id]);
    expect(store.listAutopilotRuns(feature.id)).toEqual([]);
  });

  it("rejects SCM automation filters outside the automation workspace bindings", () => {
    const { store } = seedConnection();
    const agent = store.createAgent({ name: "Wiki Maintainer", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Update repository wiki",
      workspaceId: "local",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["change.merged"],
        repositoryIds: ["repo_not_bound"],
      },
    })).toThrow("event_config.repository_ids");
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["change.merged"],
        connectionId: "scm_other_workspace",
      },
    })).toThrow("event_config.connection_id");
  });

  it("rejects event filters that the selected provider mode cannot produce", () => {
    const { store, connection } = seedConnection();
    store.updateScmConnection(connection.id, { mode: "poll" });
    const agent = store.createAgent({ name: "Wiki Maintainer", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Update repository wiki",
      workspaceId: "local",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: { resource: "scm", events: ["comment.deleted"], repositoryIds: ["repo_widgets"] },
    })).toThrow("cannot produce");
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["push.observed"],
        repositoryIds: ["repo_widgets"],
        branch: "feature/wiki",
      },
    })).toThrow("cannot produce");
    expect(() => store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: {
        resource: "scm",
        events: ["comment.created"],
        repositoryIds: ["repo_widgets"],
        branch: "main",
      },
    })).toThrow("not supported for comment or review");
  });

  it("exposes workspace-scoped connection APIs without returning secrets", async () => {
    const { store, connection } = seedConnection();
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/workspaces/local/scm/connections");
    expect(response.status).toBe(200);
    const body = await response.json() as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.id).toBe(connection.id);
    expect(JSON.stringify(body)).not.toContain("ghp_private-token");
    expect(JSON.stringify(body)).not.toContain("webhook-private-secret");
  });

  it("verifies credentials server-side and persists only structured, non-secret status", async () => {
    const { store, connection } = seedConnection();
    let observedToken = "";
    const app = createMultiremiApp({
      store,
      verifyScmConnection: async ({ credential, bindings }) => {
        observedToken = credential.accessToken ?? "";
        return {
          status: "valid",
          verifiedAt: "2026-08-22T04:00:00.000Z",
          identity: "octocat",
          repositoryCount: bindings.length,
          repositoryTotal: bindings.length,
          errorCode: null,
          error: null,
        };
      },
    });
    const response = await app.request(
      `/api/workspaces/local/scm/connections/${connection.id}/verify`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(observedToken).toBe("ghp_private-token");
    const body = await response.json() as { connection: Record<string, unknown> };
    expect(body.connection).toMatchObject({
      id: connection.id,
      verificationStatus: "valid",
      verifiedAt: "2026-08-22T04:00:00.000Z",
      verificationIdentity: "octocat",
      verifiedRepositoryCount: 1,
      verifiedRepositoryTotal: 1,
      verificationErrorCode: null,
      verificationError: null,
    });
    expect(body.connection.repositories).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ghp_private-token");

    const changed = store.updateScmConnection(connection.id, { accessToken: "replacement-token" });
    expect(changed).toMatchObject({
      verificationStatus: "unverified",
      verifiedAt: null,
      verificationIdentity: null,
      verifiedRepositoryCount: 0,
      verifiedRepositoryTotal: 0,
    });

    const staleTokenRun = store.markScmConnectionVerificationStarted(connection.id);
    store.updateScmConnection(connection.id, { accessToken: "newer-token" });
    expect(() => store.recordScmConnectionVerification(connection.id, {
      status: "valid",
      verifiedAt: "2026-08-22T04:01:00.000Z",
      identity: "stale",
      repositoryCount: 1,
      repositoryTotal: 1,
      errorCode: null,
      error: null,
    }, staleTokenRun.runId)).toThrow("changed while credentials were being verified");
    expect(store.getScmConnection(connection.id)?.verificationStatus).toBe("unverified");

    const staleBindingRun = store.markScmConnectionVerificationStarted(connection.id);
    store.updateWorkspace("local", {
      repos: [
        ...store.getWorkspace("local")!.repos,
        {
          id: "repo_new_private",
          name: "new-private",
          url: "git@github.com:acme/new-private.git",
          source: "github",
          default_branch: "main",
        },
      ],
    });
    store.reconcileScmRepositoryBindings("local");
    expect(() => store.recordScmConnectionVerification(connection.id, {
      status: "valid",
      verifiedAt: "2026-08-22T04:02:00.000Z",
      identity: "stale",
      repositoryCount: 1,
      repositoryTotal: 1,
      errorCode: null,
      error: null,
    }, staleBindingRun.runId)).toThrow("changed while credentials were being verified");
    expect(store.getScmConnection(connection.id)).toMatchObject({
      verificationStatus: "unverified",
      verifiedRepositoryCount: 0,
      verifiedRepositoryTotal: 0,
    });
  });

  it("serves camelCase issue change requests and supports manual link and unlink", async () => {
    const { store, connection } = seedConnection();
    const issue = store.createIssue({ title: "Manual API link", workspaceId: "local" });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "99",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v1",
      contentHash: "api-v1",
      payload: {
        number: 99,
        title: "No automatic issue key",
        body: "API test",
        state: "open",
        source_branch: "feature/api",
        target_branch: "main",
      },
    });
    const changeRequest = db!.query(
      "SELECT id FROM multiremi_scm_change_requests WHERE external_id = '99'",
    ).get() as { id: string };
    const app = createMultiremiApp({ store });

    const linked = await app.request(
      `/api/issues/${issue.id}/change-requests/${changeRequest.id}`,
      { method: "PUT" },
    );
    expect(linked.status).toBe(200);
    const listed = await app.request(`/api/issues/${issue.id}/change-requests`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { changeRequests: Array<Record<string, unknown>>; total: number };
    expect(listedBody.total).toBe(1);
    expect(listedBody.changeRequests[0]).toMatchObject({
      externalId: "99",
      sourceBranch: "feature/api",
      targetBranch: "main",
      repositoryName: "widgets",
      repositoryOwner: "acme",
      repositoryUrl: "git@github.com:acme/widgets.git",
    });
    expect(listedBody.changeRequests[0]).not.toHaveProperty("source_branch");

    expect((await app.request(
      `/api/issues/${issue.id}/change-requests/${changeRequest.id}`,
      { method: "DELETE" },
    )).status).toBe(204);
    expect((await (await app.request(`/api/issues/${issue.id}/change-requests`)).json() as { total: number }).total).toBe(0);
  });

  it("does not register the legacy GitHub App, webhook, settings, or pull-request APIs", async () => {
    const { store } = seedConnection();
    const app = createMultiremiApp({ store });
    const paths = [
      "/api/github/setup",
      "/api/webhooks/github",
      "/api/multiremi/github/settings",
      "/api/multiremi/github/pull-requests",
      "/api/issues/missing/pull-requests",
      "/api/workspaces/local/github/connect",
      "/api/workspaces/local/github/installations",
    ];
    for (const path of paths) expect((await app.request(path)).status).toBe(404);
  });

  it("returns a client error when connection API mutations leave webhook mode without a secret", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const store = createLocalStore();
    const app = createMultiremiApp({ store });
    const missing = await app.request("/api/workspaces/local/scm/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No secret", provider: "github", mode: "webhook" }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "SCM webhook secret is required when sync mode is webhook or hybrid",
    });

    const created = await app.request("/api/workspaces/local/scm/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Polling", provider: "github", mode: "poll" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { connection: { id: string } };
    const transition = await app.request(
      `/api/workspaces/local/scm/connections/${createdBody.connection.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "hybrid" }),
      },
    );
    expect(transition.status).toBe(400);
    expect(await transition.json()).toEqual({
      error: "SCM webhook secret is required when sync mode is webhook or hybrid",
    });

    const enabled = await app.request(
      `/api/workspaces/local/scm/connections/${createdBody.connection.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "hybrid", webhookSecret: "api-webhook-secret" }),
      },
    );
    expect(enabled.status).toBe(200);
    const preserved = await app.request(
      `/api/workspaces/local/scm/connections/${createdBody.connection.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookSecret: "" }),
      },
    );
    expect(preserved.status).toBe(200);
    expect((await preserved.json() as { connection: { webhookSecretSet: boolean } }).connection.webhookSecretSet).toBe(true);
    const cleared = await app.request(
      `/api/workspaces/local/scm/connections/${createdBody.connection.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clearWebhookSecret: true }),
      },
    );
    expect(cleared.status).toBe(400);
  });

  it("paginates events without dropping rows that share an observed timestamp", async () => {
    const { store, connection } = seedConnection();
    const observedAt = "2026-08-21T10:00:00.000Z";
    recordChange(store, connection.id, { logicalKey: "change.merged:41:a", observedAt });
    recordChange(store, connection.id, { logicalKey: "change.merged:42:b", observedAt });
    recordChange(store, connection.id, { logicalKey: "change.merged:43:c", observedAt });

    const app = createMultiremiApp({ store });
    const first = await app.request("/api/workspaces/local/scm/events?limit=2");
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { events: Array<{ id: string }>; total: number; nextAfter: string | null };
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.total).toBe(2);
    expect(firstBody.nextAfter).toBe(firstBody.events[1]?.id);

    const second = await app.request(`/api/workspaces/local/scm/events?limit=2&after=${encodeURIComponent(firstBody.nextAfter!)}`);
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { events: Array<{ id: string }>; total: number; nextAfter: string | null };
    expect(secondBody.events).toHaveLength(1);
    expect(secondBody.nextAfter).toBeNull();
    expect(new Set([...firstBody.events, ...secondBody.events].map((event) => event.id)).size).toBe(3);

    const wrongScope = await app.request(
      `/api/workspaces/local/scm/events?repositoryId=repo_other&after=${encodeURIComponent(firstBody.nextAfter!)}`,
    );
    expect(wrongScope.status).toBe(400);
  });
});
