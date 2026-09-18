import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { sha256Text } from "@multiremi/project-knowledge/codec.js";
import { canonicalRepositoryWikiBody } from "@multiremi/repository-wiki/codec.js";
import {
  RepositoryWikiLogRepairConflictError,
  RepositoryWikiService,
} from "@multiremi/repository-wiki/service.js";
import { configureRepositoryWikiAutomation, createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.updateWorkspaceRepositories("local", [{
    id: "repo_log", name: "log", url: "https://github.com/acme/log.git", source: "github", default_branch: "main",
  }]);
  const log = store.createRepositoryWikiDoc("local", "repo_log", {
    path: "log.md", title: "Log", body: "# Log\n\n## Original\n\nSee [[guides/page]].",
  });
  const page = store.createRepositoryWikiDoc("local", "repo_log", {
    path: "guides/page.md", title: "Page", body: "Page body",
  });
  const other = store.createRepositoryWikiDoc("local", "repo_log", {
    path: "guides/other.md", title: "Other", body: "Other body",
  });
  return { store, service: new RepositoryWikiService(store, null, "sql"), log, page, other };
}

describe("Repository Wiki log history", () => {
  it("accepts appends, rejects replacements and deletes, and leaves mixed batches untouched", async () => {
    const { store, service, log, page } = fixture();
    const appended = await service.update("local", "repo_log", log.id, {
      body: `${log.body}\r\n\r\n## Appended\r\n\r\nEntry   \r\n`, expectedVersion: 1,
    });
    expect(appended.body).toContain("## Appended");
    await expect(service.update("local", "repo_log", log.id, {
      body: "# Foreign log", expectedVersion: 2,
    })).rejects.toThrow("append-only");
    await expect(service.delete("local", "repo_log", log.id, 2)).rejects.toThrow("cannot be moved or deleted");
    await expect(service.applyBatch("local", "repo_log", [
      { kind: "update", ref: log.id, input: { body: "# Replaced", expectedVersion: 2 } },
      { kind: "update", ref: page.id, input: { body: "Changed", expectedVersion: 1 } },
    ])).rejects.toThrow("append-only");
    expect(store.getRepositoryWikiDocByRef("local", "repo_log", log.id)?.version).toBe(2);
    expect(store.getRepositoryWikiDocByRef("local", "repo_log", page.id)).toMatchObject({ version: 1, body: "Page body" });
  });

  it("rejects stale concurrent appends and preserves both entries after a current-baseline retry", async () => {
    const { service, log } = fixture();
    const firstBody = `${log.body}\n\n## First writer\n\nEntry one`;
    const first = await service.update("local", "repo_log", log.id, {
      body: firstBody,
      expectedVersion: 1,
    });
    await expect(service.update("local", "repo_log", log.id, {
      body: `${log.body}\n\n## Stale writer\n\nEntry two`,
      expectedVersion: 1,
    })).rejects.toThrow("version conflict");
    const retried = await service.update("local", "repo_log", log.id, {
      body: `${first.body}\n\n## Retried writer\n\nEntry two`,
      expectedVersion: first.version,
    });
    expect(retried.body).toContain("## First writer");
    expect(retried.body).toContain("## Retried writer");
    expect(retried.version).toBe(3);
  });

  it("allows only service-generated link rewrites during move and merge", async () => {
    const { service, log, page, other } = fixture();
    await service.move("local", "repo_log", page.id, "concepts/page.md", { expectedVersion: 1 });
    expect((await service.get("local", "repo_log", log.id))?.body).toContain("[[concepts/page.md]]");
    await service.merge("local", "repo_log", page.id, [other.id], { expectedVersion: 2 });
    const after = await service.get("local", "repo_log", log.id);
    expect(after?.body).toContain("[[concepts/page.md]]");
    expect(await service.get("local", "repo_log", other.id)).toBeNull();
    await expect(service.move("local", "repo_log", log.id, "archive/log.md", { expectedVersion: after!.version }))
      .rejects.toThrow("cannot be moved");
  });

  it("repairs a pinned baseline and rejects stale version or body hashes", async () => {
    const { service, log } = fixture();
    const baseline = sha256Text(canonicalRepositoryWikiBody(log.body));
    const repaired = await service.repairLog("local", "repo_log", {
      body: "# Restored log\n\n## Original\n\nRecovered",
      expectedVersion: 1,
      expectedBodySha256: baseline,
      reason: "Recover records lost after a cross-task temporary-file collision",
    });
    expect(repaired.doc).toMatchObject({ id: log.id, path: "log.md", version: 2 });
    expect(repaired.audit.before.body_sha256).toBe(baseline);
    expect(repaired.audit.after.body_sha256).toBe(sha256Text(canonicalRepositoryWikiBody(repaired.doc.body)));
    await expect(service.repairLog("local", "repo_log", {
      body: "stale overwrite", expectedVersion: 1, expectedBodySha256: baseline, reason: "retry",
    })).rejects.toBeInstanceOf(RepositoryWikiLogRepairConflictError);
    expect((await service.get("local", "repo_log", log.id))?.version).toBe(2);
  });

  it("rejects replacement through single, batch/push, and publish routes with zero partial writes", async () => {
    const { store, log, page } = fixture();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { "Content-Type": "application/json", Authorization: "Bearer root-secret" };
    const single = await app.request(`/api/workspaces/local/repos/repo_log/wiki/${log.id}`, {
      method: "PUT", headers, body: JSON.stringify({ body: "# Foreign", expected_version: 1 }),
    });
    expect(single.status).toBe(409);

    const batch = await app.request("/api/workspaces/local/repos/repo_log/wiki/batch", {
      method: "POST", headers, body: JSON.stringify({ operations: [
        { kind: "update", ref: log.id, input: { body: "# Foreign", expected_version: 1 } },
        { kind: "update", ref: page.id, input: { body: "Changed", expected_version: 1 } },
      ] }),
    });
    expect(batch.status).toBe(409);
    expect(store.getRepositoryWikiDocByRef("local", "repo_log", page.id)).toMatchObject({ version: 1, body: "Page body" });

    const { agent, autopilot } = configureRepositoryWikiAutomation(store);
    const autoRun = store.runAutopilot(autopilot.id, {
      source: "scm_event", repositoryId: "repo_log", dedupeKey: "repo_log:log-guard",
      payload: { repository_wiki_repository_id: "repo_log" },
    });
    const task = store.getTask(autoRun.taskId!)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const submission = store.createKnowledgeSubmission({
      workspaceId: "local", repositoryId: "repo_log", scope: "repository_wiki", sourceType: "agent",
      body: "replace", sourceTaskId: task.id, authorAgentId: agent.id,
    }).submission;
    const publish = await app.request("/api/workspaces/local/repos/repo_log/wiki/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        submission_ids: [submission.id], dedupe_key: "log-replacement",
        outputs: [
          { action: "update", ref: log.id, expected_version: 1, body: "# Foreign" },
          { action: "update", ref: page.id, expected_version: 1, body: "Changed" },
        ],
      }),
    });
    expect(publish.status).toBe(409);
    expect(store.getRepositoryWikiDocByRef("local", "repo_log", log.id)?.version).toBe(1);
    expect(store.getRepositoryWikiDocByRef("local", "repo_log", page.id)?.version).toBe(1);
    expect(store.listKnowledgeCompilationRuns({ workspaceId: "local", repositoryId: "repo_log" }).some(run =>
      run.dedupeKey === "log-replacement" && run.status === "failed")).toBe(true);
  });

  it("restricts audited repair to scoped publishers and administrators", async () => {
    const { store, log } = fixture();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const repair = (token: string, body: string, expectedVersion: number, expectedBodySha256: string) => app.request(
      "/api/workspaces/local/repos/repo_log/wiki/repair-log",
      {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        body,
        expected_version: expectedVersion,
        expected_body_sha256: expectedBodySha256,
        reason: "MUL-316 verified recovery",
      }),
    });

    const project = store.createProject({
      title: "Repair scope",
      resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/log.git" } }],
    });
    const issue = store.createIssue({ title: "Repair", projectId: project.id });
    const ordinaryAgent = store.createAgent({ name: "Ordinary", provider: "claude" });
    const ordinaryTask = store.createTask({ agentId: ordinaryAgent.id, issueId: issue.id, prompt: "repair" });
    const ordinaryToken = await store.createTaskAccessToken(ordinaryTask, "local");
    const initialHash = sha256Text(canonicalRepositoryWikiBody(log.body));
    expect((await repair(ordinaryToken.token, "# Denied", 1, initialHash)).status).toBe(403);
    expect(store.getRepositoryWikiDocByRef("local", "repo_log", log.id)?.version).toBe(1);
    expect(store.listKnowledgeCompilationRuns({ workspaceId: "local", repositoryId: "repo_log" })).toEqual([]);

    const { autopilot } = configureRepositoryWikiAutomation(store);
    const publisherRun = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      repositoryId: "repo_log",
      dedupeKey: "repo_log:repair-log",
      payload: { repository_wiki_repository_id: "repo_log" },
    });
    const publisherToken = await store.createTaskAccessToken(store.getTask(publisherRun.taskId!)!, "local");
    const published = await repair(publisherToken.token, "# Recovered\n\nHistory", 1, initialHash);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      doc: { id: log.id, path: "log.md", version: 2, body: "# Recovered\n\nHistory" },
      audit: { reason: "MUL-316 verified recovery", before: { version: 1 }, after: { version: 2 } },
      run: { status: "published" },
    });

    const publisherBody = "# Recovered\n\nHistory";
    const response = await repair(
      "root-secret",
      `${publisherBody}\n\n## Admin correction`,
      2,
      sha256Text(canonicalRepositoryWikiBody(publisherBody)),
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload).toMatchObject({
      doc: { id: log.id, path: "log.md", version: 3, body: `${publisherBody}\n\n## Admin correction` },
      audit: { reason: "MUL-316 verified recovery", before: { version: 2 }, after: { version: 3 } },
      run: { status: "published" },
    });
    expect(JSON.parse(store.getKnowledgeCompilationRun(payload.run.id)!.resultSummary!)).toMatchObject({
      operation: "repository_wiki_log_repair",
      reason: "MUL-316 verified recovery",
      before: { version: 2 },
      after: { version: 3 },
    });
  });
});
