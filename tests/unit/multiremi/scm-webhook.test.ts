import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { GitHubScmProviderAdapter } from "@multiremi/scm/github.js";
import { reconcileObservation } from "@multiremi/scm/reconcile.js";
import { ScmWebhookError, ScmWebhookIngestor } from "@multiremi/scm/webhook.js";
import { MemoryScmIngestionStore, scmBinding, scmConnection } from "./scm-test-helpers.js";

describe("SCM webhook ingestion", () => {
  it("verifies and normalizes a GitHub pull request webhook", () => {
    const store = new MemoryScmIngestionStore();
    const ingestor = new ScmWebhookIngestor(store);
    const body = {
      action: "closed",
      repository: { id: 101, name: "widgets", owner: { login: "acme" }, default_branch: "main" },
      pull_request: {
        id: 9001,
        number: 42,
        title: "Ship it",
        state: "closed",
        merged: true,
        merged_at: "2026-08-21T08:01:00.000Z",
        updated_at: "2026-08-21T08:01:00.000Z",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main", sha: "def" },
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", "secret").update(rawBody).digest("hex");
    const result = ingestor.ingest({
      connectionId: "scm_1",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      rawBody,
      body,
      observedAt: "2026-08-21T08:02:00.000Z",
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event.type).toBe("change.merged");
    expect(result.events[0]?.event.fidelity).toBe("exact");
    expect(result.events[0]?.event.repositoryId).toBe("repo_1");
    expect(result.events[0]?.created).toBe(true);

    const duplicate = ingestor.ingest({
      connectionId: "scm_1",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      rawBody,
      body,
    });
    expect(duplicate.events[0]?.created).toBe(false);
    expect(duplicate.events[0]?.evidenceCreated).toBe(false);
  });

  it("fails closed when a GitHub signature is missing", () => {
    const store = new MemoryScmIngestionStore();
    const ingestor = new ScmWebhookIngestor(store);
    expect(() => ingestor.ingest({
      connectionId: "scm_1",
      headers: { "x-github-event": "push" },
      rawBody: "{}",
      body: {},
    })).toThrow(ScmWebhookError);
    expect(store.events.size).toBe(0);
  });

  it("accepts the Codebase token header and maps a default-branch push", () => {
    const store = new MemoryScmIngestionStore();
    store.connections = [scmConnection({
      provider: "codebase",
      apiBaseUrl: "https://codebase-api.byted.org/v2/",
      baseUrl: "https://code.byted.org",
    })];
    store.bindings = [scmBinding({
      repositoryUrl: "https://code.byted.org/acme/widgets.git",
      externalId: "101",
    })];
    const body = {
      repository: { Id: "101", Path: "acme/widgets", Name: "widgets", DefaultBranch: "main" },
      Ref: "refs/heads/main",
      Before: "aaa",
      After: "bbb",
    };
    const result = new ScmWebhookIngestor(store).ingest({
      connectionId: "scm_1",
      headers: { "x-vecode-event": "push", "x-vecode-token": "secret", "x-vecode-event-id": "evt-2" },
      rawBody: JSON.stringify(body),
      body,
    });
    expect(result.events.map((entry) => entry.event.type)).toEqual(["push.observed", "default_branch.updated"]);
  });

  it("accepts a valid delivery for an unbound repository without triggering automation", () => {
    const store = new MemoryScmIngestionStore();
    const body = {
      repository: { id: 999, name: "other", owner: { login: "acme" }, default_branch: "main" },
      ref: "refs/heads/main",
      before: "aaa",
      after: "bbb",
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", "secret").update(rawBody).digest("hex");
    const result = new ScmWebhookIngestor(store).ingest({
      connectionId: "scm_1",
      headers: { "x-github-event": "push", "x-hub-signature-256": `sha256=${signature}` },
      rawBody,
      body,
    });
    expect(result.events).toHaveLength(0);
    expect(result.ignoredReason).toContain("not bound");
  });

  it("keeps webhook snapshots current so the following poll does not invent an event", () => {
    const store = new MemoryScmIngestionStore();
    const opened = githubPullBody("opened", "First title", "2026-08-21T08:00:00.000Z", "aaa");
    const edited = githubPullBody("edited", "Current title", "2026-08-21T08:05:00.000Z", "bbb");
    ingestGitHub(store, "pull_request", opened, "delivery-open", "2026-08-21T08:00:01.000Z");
    ingestGitHub(store, "pull_request", edited, "delivery-edit", "2026-08-21T08:05:01.000Z");

    expect([...store.events.values()].map((event) => event.type)).toEqual(["change.opened", "change.updated"]);
    const snapshot = store.getEntitySnapshot("scm_1", "repo_1", "change_request", "9001")!;
    expect(snapshot.payload).toMatchObject({ title: "Current title", head_sha: "bbb" });

    const candidate = new GitHubScmProviderAdapter().parseWebhook({
      connection: scmConnection(),
      credential: { accessToken: "token", webhookSecret: "secret" },
      headers: { "x-github-event": "pull_request" },
      rawBody: JSON.stringify(edited),
      body: edited,
      observedAt: "2026-08-21T08:06:00.000Z",
    }).candidates[0]!;
    const polled = reconcileObservation({
      store,
      binding: scmBinding(),
      observation: candidate.snapshotObservation!,
      baseline: false,
      source: "poll",
    });
    expect(polled.changed).toBe(false);
    expect(polled.events).toHaveLength(0);
    expect(store.events.size).toBe(2);
  });

  it("rejects a stale webhook snapshot while preserving its exact historical event", () => {
    const store = new MemoryScmIngestionStore();
    const newer = githubPullBody("edited", "Current title", "2026-08-21T08:05:00.000Z", "bbb");
    const older = githubPullBody("opened", "Old title", "2026-08-21T08:00:00.000Z", "aaa");
    ingestGitHub(store, "pull_request", newer, "delivery-new", "2026-08-21T08:05:01.000Z");
    ingestGitHub(store, "pull_request", older, "delivery-old", "2026-08-21T08:06:00.000Z");

    const snapshot = store.getEntitySnapshot("scm_1", "repo_1", "change_request", "9001")!;
    expect(snapshot.payload).toMatchObject({ title: "Current title", head_sha: "bbb" });
    expect([...store.events.values()].map((event) => event.type)).toEqual(["change.updated", "change.opened"]);
  });

  it("upgrades inferred poll evidence to exact webhook fidelity without later downgrade", () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new GitHubScmProviderAdapter();
    const openBody = githubPullBody("opened", "Ship it", "2026-08-21T08:00:00.000Z", "aaa");
    const mergedBody = githubPullBody("closed", "Ship it", "2026-08-21T08:05:00.000Z", "bbb", true);
    const parsedOpen = parseGitHubPull(adapter, openBody, "2026-08-21T08:00:01.000Z");
    const parsedMerged = parseGitHubPull(adapter, mergedBody, "2026-08-21T08:05:01.000Z");

    reconcileObservation({
      store,
      binding: scmBinding(),
      observation: parsedOpen.snapshotObservation!,
      baseline: true,
      source: "poll",
    });
    const inferred = reconcileObservation({
      store,
      binding: scmBinding(),
      observation: parsedMerged.snapshotObservation!,
      baseline: false,
      source: "poll",
    });
    expect(inferred.events[0]?.event.fidelity).toBe("inferred");

    const exact = ingestGitHub(store, "pull_request", mergedBody, "delivery-merge", "2026-08-21T08:05:02.000Z");
    expect(exact.events[0]?.created).toBe(false);
    expect(exact.events[0]?.event.fidelity).toBe("exact");
    const repeatedPoll = reconcileObservation({
      store,
      binding: scmBinding(),
      observation: parsedMerged.snapshotObservation!,
      baseline: false,
      source: "poll",
    });
    expect(repeatedPoll.events).toHaveLength(0);
    expect([...store.events.values()][0]?.fidelity).toBe("exact");
  });
});

function githubPullBody(
  action: string,
  title: string,
  updatedAt: string,
  headSha: string,
  merged = false,
) {
  return {
    action,
    repository: { id: 101, name: "widgets", owner: { login: "acme" }, default_branch: "main" },
    pull_request: {
      id: 9001,
      number: 42,
      title,
      state: merged ? "closed" : "open",
      merged,
      created_at: "2026-08-21T08:00:00.000Z",
      updated_at: updatedAt,
      closed_at: merged ? updatedAt : null,
      merged_at: merged ? updatedAt : null,
      head: { ref: "feature", sha: headSha },
      base: { ref: "main", sha: "base" },
    },
  };
}

function parseGitHubPull(
  adapter: GitHubScmProviderAdapter,
  body: ReturnType<typeof githubPullBody>,
  observedAt: string,
) {
  return adapter.parseWebhook({
    connection: scmConnection(),
    credential: { accessToken: "token", webhookSecret: "secret" },
    headers: { "x-github-event": "pull_request" },
    rawBody: JSON.stringify(body),
    body,
    observedAt,
  }).candidates[0]!;
}

function ingestGitHub(
  store: MemoryScmIngestionStore,
  event: string,
  body: Record<string, unknown>,
  delivery: string,
  observedAt: string,
) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", "secret").update(rawBody).digest("hex");
  return new ScmWebhookIngestor(store).ingest({
    connectionId: "scm_1",
    headers: {
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    rawBody,
    body,
    observedAt,
  });
}
