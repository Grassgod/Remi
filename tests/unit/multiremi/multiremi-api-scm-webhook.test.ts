import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const originalEncryptionKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Multiremi API — normalized SCM webhooks", () => {
  it("accepts a signed provider webhook and persists one deduplicated canonical event", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git", defaultBranch: "main" }],
    });
    store.createScmConnection({
      id: "scm_github",
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "hybrid",
      accessToken: "token",
      webhookSecret: "webhook-secret",
      repositoryIds: ["repo_widgets"],
    });
    const body = {
      action: "opened",
      repository: { id: 101, name: "widgets", owner: { login: "acme" }, default_branch: "main" },
      pull_request: {
        id: 9001,
        number: 42,
        title: "Ship it",
        state: "open",
        created_at: "2026-08-21T07:00:00.000Z",
        updated_at: "2026-08-21T07:00:00.000Z",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main", sha: "def" },
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", "webhook-secret").update(rawBody).digest("hex");
    const app = createMultiremiApp({ store, authToken: "dashboard-secret" });
    const send = () => app.request("/api/webhooks/scm/scm_github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "delivery-1",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: rawBody,
    });

    const accepted = await send();
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      provider: "github",
      provider_event: "pull_request",
      events: [{ type: "change.opened", created: true, evidence_created: true }],
    });
    const events = store.listScmCanonicalEvents({ workspaceId: "local" });
    expect(events).toHaveLength(1);
    expect(store.listScmEventEvidence(events[0]!.id)).toHaveLength(1);

    const duplicate = await send();
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json()).events[0]).toMatchObject({ created: false, evidence_created: false });
    expect(store.listScmCanonicalEvents({ workspaceId: "local" })).toHaveLength(1);
  });

  it("rejects an unsigned webhook before parsing or persistence", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git", defaultBranch: "main" }],
    });
    store.createScmConnection({
      id: "scm_github",
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "webhook",
      webhookSecret: "webhook-secret",
      repositoryIds: ["repo_widgets"],
    });
    const response = await createMultiremiApp({ store }).request("/api/webhooks/scm/scm_github", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "push" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "scm_webhook_signature_invalid" });
    expect(store.listScmCanonicalEvents({ workspaceId: "local" })).toHaveLength(0);
  });
});

