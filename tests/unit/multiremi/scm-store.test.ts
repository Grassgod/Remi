import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { decryptScmCredential, encryptScmCredential } from "@multiremi/scm/credentials.js";
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
    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "poll",
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
    expect(store.deleteScmConnection(connection.id)).toBe(true);
    expect(store.getScmSyncCursor(connection.id, "repo_widgets", "default_branch")).toBeNull();
    expect(store.getScmEntitySnapshot(connection.id, "repo_widgets", "ref", "main")).toBeNull();
    expect(store.listScmRepositoryBindings({ connectionId: connection.id })).toEqual([]);
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
