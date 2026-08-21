import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
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
});

