import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { agentHasKnowledgePublishCapability } from "@multiremi/knowledge/capability.js";
import { configureRepositoryWikiAutomation, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const JSON_HEADERS = { "Content-Type": "application/json" };
const ROOT_JSON_HEADERS = { ...JSON_HEADERS, Authorization: "Bearer root-secret" };

describe("knowledge compilation control plane", () => {
  it("migrates the SQLite schema additively and deduplicates only pending raw submissions", () => {
    const store = createStore();
    const tables = (db!.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toContain("multiremi_knowledge_submissions");
    expect(tables).toContain("multiremi_knowledge_compilation_runs");
    expect(tables).toContain("multiremi_knowledge_compilation_run_sources");
    expect(tables).toContain("multiremi_knowledge_compilation_outputs");
    for (const table of [
      "multiremi_project_docs",
      "multiremi_project_doc_revisions",
      "multiremi_repository_wiki_docs",
      "multiremi_repository_wiki_doc_revisions",
    ]) {
      const columns = (db!.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toContain("compilation_run_id");
    }

    const project = store.createProject({ title: "Raw dedupe" });
    const input = {
      workspaceId: "local",
      projectId: project.id,
      scope: "memory" as const,
      sourceType: "agent" as const,
      proposedSlug: "stable-fact",
      body: "Bun 1.3.14 is required.",
    };
    const first = store.createKnowledgeSubmission(input);
    const retry = store.createKnowledgeSubmission({ ...input, proposedSlug: "different-suggestion" });
    expect(retry).toMatchObject({ deduplicated: true, submission: { id: first.submission.id } });
    store.updateKnowledgeSubmissionStatus(first.submission.id, "consumed");
    const next = store.createKnowledgeSubmission(input);
    expect(next.deduplicated).toBe(false);
    expect(next.submission.id).not.toBe(first.submission.id);
  });

  it("paginates submissions and compilation runs with stable composite ordering", () => {
    const store = createStore();
    const project = store.createProject({ title: "Knowledge pagination" });
    const submissions = Array.from({ length: 3 }, (_, index) => store.createKnowledgeSubmission({
      workspaceId: "local",
      projectId: project.id,
      scope: "memory",
      sourceType: "external",
      body: `raw-${index}`,
    }).submission);
    const runs = Array.from({ length: 3 }, () => store.createKnowledgeCompilationRun({
      workspaceId: "local",
      projectId: project.id,
      mode: "manual_edit",
    }).run);
    const createdAt = "2026-09-03T10:00:00.000Z";
    for (const submission of submissions) {
      db!.run("UPDATE multiremi_knowledge_submissions SET created_at = ? WHERE id = ?", [createdAt, submission.id]);
    }
    for (const run of runs) {
      db!.run("UPDATE multiremi_knowledge_compilation_runs SET created_at = ? WHERE id = ?", [createdAt, run.id]);
    }

    const expectedSubmissionIds = submissions.map(({ id }) => id).sort().reverse();
    const firstSubmissions = store.listKnowledgeSubmissionsPage({
      workspaceId: "local",
      projectId: project.id,
      limit: 2,
    });
    expect(firstSubmissions.items.map(({ id }) => id)).toEqual(expectedSubmissionIds.slice(0, 2));
    expect(firstSubmissions.nextCursor).toBe(expectedSubmissionIds[1]);
    const remainingSubmissions = store.listKnowledgeSubmissionsPage({
      workspaceId: "local",
      projectId: project.id,
      cursor: firstSubmissions.nextCursor,
      limit: 2,
    });
    expect(remainingSubmissions.items.map(({ id }) => id)).toEqual(expectedSubmissionIds.slice(2));
    expect(remainingSubmissions.nextCursor).toBeNull();

    const expectedRunIds = runs.map(({ id }) => id).sort().reverse();
    const firstRuns = store.listKnowledgeCompilationRunsPage({
      workspaceId: "local",
      projectId: project.id,
      limit: 2,
    });
    expect(firstRuns.items.map(({ id }) => id)).toEqual(expectedRunIds.slice(0, 2));
    expect(firstRuns.nextCursor).toBe(expectedRunIds[1]);
    const remainingRuns = store.listKnowledgeCompilationRunsPage({
      workspaceId: "local",
      projectId: project.id,
      cursor: firstRuns.nextCursor,
      limit: 2,
    });
    expect(remainingRuns.items.map(({ id }) => id)).toEqual(expectedRunIds.slice(2));
    expect(remainingRuns.nextCursor).toBeNull();

    const otherProject = store.createProject({ title: "Other pagination scope" });
    expect(() => store.listKnowledgeSubmissionsPage({
      workspaceId: "local",
      projectId: otherProject.id,
      cursor: firstSubmissions.nextCursor,
    })).toThrow("cursor is invalid or does not match the requested scope");
    expect(() => store.listKnowledgeCompilationRunsPage({
      workspaceId: "local",
      projectId: otherProject.id,
      cursor: firstRuns.nextCursor,
    })).toThrow("cursor is invalid or does not match the requested scope");
  });

  it("returns and consumes next_cursor for submission and run API pages", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Knowledge API pagination" });
    const submissions = Array.from({ length: 3 }, (_, index) => store.createKnowledgeSubmission({
      workspaceId: "local",
      projectId: project.id,
      scope: "project_wiki",
      sourceType: "external",
      body: `api-raw-${index}`,
    }).submission);
    const runs = Array.from({ length: 3 }, () => store.createKnowledgeCompilationRun({
      workspaceId: "local",
      projectId: project.id,
      mode: "issue_ingest",
    }).run);
    const createdAt = "2026-09-03T11:00:00.000Z";
    for (const submission of submissions) {
      db!.run("UPDATE multiremi_knowledge_submissions SET created_at = ? WHERE id = ?", [createdAt, submission.id]);
    }
    for (const run of runs) {
      db!.run("UPDATE multiremi_knowledge_compilation_runs SET created_at = ? WHERE id = ?", [createdAt, run.id]);
    }
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: "Bearer root-secret" };

    const firstSubmissionResponse = await app.request(
      `/api/knowledge/submissions?workspace_id=local&project_id=${project.id}&limit=2`,
      { headers },
    );
    expect(firstSubmissionResponse.status).toBe(200);
    const firstSubmissions = await firstSubmissionResponse.json() as any;
    expect(firstSubmissions.submissions).toHaveLength(2);
    expect(firstSubmissions.next_cursor).toBe(firstSubmissions.submissions[1].id);
    const secondSubmissions = await (await app.request(
      `/api/knowledge/submissions?workspace_id=local&project_id=${project.id}&limit=2&cursor=${firstSubmissions.next_cursor}`,
      { headers },
    )).json() as any;
    expect(secondSubmissions.submissions).toHaveLength(1);
    expect(secondSubmissions.next_cursor).toBeNull();
    expect(new Set([...firstSubmissions.submissions, ...secondSubmissions.submissions].map(({ id }: any) => id))).toEqual(
      new Set(submissions.map(({ id }) => id)),
    );

    const firstRunResponse = await app.request(
      `/api/knowledge/runs?workspace_id=local&project_id=${project.id}&limit=2`,
      { headers },
    );
    expect(firstRunResponse.status).toBe(200);
    const firstRuns = await firstRunResponse.json() as any;
    expect(firstRuns.runs).toHaveLength(2);
    expect(firstRuns.next_cursor).toBe(firstRuns.runs[1].id);
    const secondRuns = await (await app.request(
      `/api/knowledge/runs?workspace_id=local&project_id=${project.id}&limit=2&cursor=${firstRuns.next_cursor}`,
      { headers },
    )).json() as any;
    expect(secondRuns.runs).toHaveLength(1);
    expect(secondRuns.next_cursor).toBeNull();
    expect(new Set([...firstRuns.runs, ...secondRuns.runs].map(({ id }: any) => id))).toEqual(
      new Set(runs.map(({ id }) => id)),
    );

    const invalidCursor = await app.request(
      `/api/knowledge/runs?workspace_id=local&project_id=${project.id}&cursor=krun_missing`,
      { headers },
    );
    expect(invalidCursor.status).toBe(400);
  });

  it("derives publish capability from maintainer role and an enabled allowlisted plugin", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const namedAtlas = store.createAgent({ name: "Atlas", provider: "claude", role: "maintainer" });
    expect(agentHasKnowledgePublishCapability(store, namedAtlas)).toBe(false);

    const contributor = store.createAgent({ name: "ordinary", provider: "claude", role: "normal" });
    configureRepositoryWikiAutomation(store, { agent: contributor });
    expect(agentHasKnowledgePublishCapability(store, contributor)).toBe(false);

    const configured = store.getAgent(contributor.id)!;
    const maintainer = store.updateAgent(configured.id, { role: "maintainer" });
    expect(agentHasKnowledgePublishCapability(store, maintainer)).toBe(true);
    const binding = store.listAgentPluginBindings(maintainer.id)[0]!;
    store.updateAgentPluginBinding(maintainer.id, binding.id, { enabled: false });
    expect(agentHasKnowledgePublishCapability(store, store.getAgent(maintainer.id)!)).toBe(false);
  });

  it("routes ordinary task writes to Raw, trusts only token identity, and excludes Raw from recall", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Raw routing" });
    const issue = store.createIssue({ title: "Collect a fact", projectId: project.id });
    const agent = store.createAgent({ name: "Executor", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "collect" });
    const credential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const request = () => app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        kind: "memory",
        title: "Raw fact",
        body: "raw-only-marker",
        source_task_id: "tsk_forged",
        source_issue_id: "iss_forged",
        author_id: "agt_forged",
      }),
    });
    const first = await request();
    expect(first.status).toBe(202);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({ status: "pending", scope: "memory", deduplicated: false });
    const submission = store.getKnowledgeSubmission(firstBody.submission_id)!;
    expect(submission).toMatchObject({
      sourceTaskId: task.id,
      sourceIssueId: issue.id,
      authorAgentId: agent.id,
      body: "raw-only-marker",
    });
    const retry = await request();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ submission_id: submission.id, deduplicated: true });
    const rawList = await app.request("/api/knowledge/submissions?workspace_id=local", {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect((await rawList.json() as any).submissions[0]).toMatchObject({
      id: submission.id,
      source_issue: { id: issue.id, key: issue.key, title: issue.title },
      author_agent: { id: agent.id, name: agent.name },
      source_task: { id: task.id, status: task.status },
    });
    expect((await (await app.request(`/api/projects/${project.id}/docs?q=raw-only-marker`, {
      headers: { Authorization: "Bearer root-secret" },
    })).json() as any).docs).toEqual([]);
    expect((await (await app.request(`/api/projects/${project.id}/knowledge/recall?q=raw-only-marker`, {
      headers: { Authorization: "Bearer root-secret" },
    })).json() as any).hits).toEqual([]);
  });

  it("lets a capable task publish multiple Raw inputs with deterministic preflight and provenance", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const project = store.createProject({ title: "Atlas publishing" });
    const issue = store.createIssue({ title: "Curate knowledge", projectId: project.id });
    const { agent } = configureRepositoryWikiAutomation(store);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "curate" });
    const credential = await store.createTaskAccessToken(task, "local");
    const first = store.createKnowledgeSubmission({
      workspaceId: "local", projectId: project.id, scope: "project_wiki", sourceType: "agent",
      proposedPath: "guides/source-a.md", body: "source a", sourceTaskId: task.id, sourceIssueId: issue.id,
    }).submission;
    const second = store.createKnowledgeSubmission({
      workspaceId: "local", projectId: project.id, scope: "project_wiki", sourceType: "agent",
      proposedPath: "guides/source-b.md", body: "source b", sourceTaskId: task.id, sourceIssueId: issue.id,
    }).submission;
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const publish = await app.request(`/api/projects/${project.id}/knowledge/publish`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        submission_ids: [first.id, second.id],
        dedupe_key: "atlas-project-batch-1",
        outputs: [
          { action: "create", kind: "wiki", path: "guides/overview.md", title: "Overview", body: "See [[details]]." },
          { action: "create", kind: "wiki", path: "guides/details.md", title: "Details", body: "Compiled details." },
        ],
      }),
    });
    expect(publish.status).toBe(200);
    const published = await publish.json() as any;
    expect(published.outputs).toHaveLength(3);
    expect(store.listKnowledgeRunSources(published.run.id).filter((source) => source.sourceType === "submission")).toHaveLength(2);
    const overview = store.getProjectDocByRef(project.id, "overview")!;
    expect(overview.compilationRunId).toBe(published.run.id);
    expect(store.listProjectDocRevisions(overview.id)[0]!.compilationRunId).toBe(published.run.id);
    expect(store.getKnowledgeSubmission(first.id)?.status).toBe("consumed");
    expect(store.getKnowledgeSubmission(second.id)?.status).toBe("consumed");
    const runList = await app.request("/api/knowledge/runs?workspace_id=local", {
      headers: { Authorization: "Bearer root-secret" },
    });
    const runDetail = (await runList.json() as any).runs[0];
    expect(runDetail).toMatchObject({
      id: published.run.id,
      agent: { id: agent.id, name: agent.name },
    });
    expect(runDetail.sources).toHaveLength(2);
    expect(runDetail.sources.every((source: any) => source.submission === null)).toBe(true);
    expect(runDetail.outputs).toHaveLength(3);
    expect(runDetail.outputs.some((output: any) => output.artifact?.title === "Overview")).toBe(true);

    const detailResponse = await app.request(`/api/knowledge/runs/${published.run.id}`, {
      headers: { Authorization: "Bearer root-secret" },
    });
    const detailedRun = await detailResponse.json() as any;
    expect(detailedRun.sources.map((source: any) => source.submission?.id).sort()).toEqual([first.id, second.id].sort());

    const duplicate = await app.request(`/api/projects/${project.id}/knowledge/publish`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        submission_ids: [first.id],
        dedupe_key: "atlas-project-batch-1",
        output: { action: "noop" },
      }),
    });
    expect(duplicate.status).toBe(409);

    const unresolvedSource = store.createKnowledgeSubmission({
      workspaceId: "local", projectId: project.id, scope: "project_wiki", sourceType: "agent",
      body: "bad link", sourceTaskId: task.id, sourceIssueId: issue.id,
    }).submission;
    const unresolved = await app.request(`/api/projects/${project.id}/knowledge/publish`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        submission_ids: [unresolvedSource.id],
        dedupe_key: "atlas-project-batch-2",
        output: { action: "create", kind: "wiki", title: "Broken", body: "See [[missing]]." },
      }),
    });
    expect(unresolved.status).toBe(409);
    expect((await unresolved.json() as any).error).toContain("unresolved wiki link");
  });

  it("records human edits as manual compilation runs, including the seeded schema", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Manual provenance" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const created = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: ROOT_JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "Manual guide", body: "v1" }),
    });
    expect(created.status).toBe(201);
    const doc = (await created.json() as any).doc;
    const run = store.getKnowledgeCompilationRun(doc.compilation_run_id)!;
    expect(run).toMatchObject({ mode: "manual_edit", status: "published", agentId: null, taskId: null });
    expect(store.listProjectDocRevisions(doc.id)[0]?.compilationRunId).toBe(run.id);
    expect(store.getProjectDocByRef(project.id, "_schema")?.compilationRunId).toBe(run.id);
    expect(store.listKnowledgeRunOutputs(run.id)).toHaveLength(2);

    const updated = await app.request(`/api/projects/${project.id}/docs/${doc.id}`, {
      method: "PUT",
      headers: ROOT_JSON_HEADERS,
      body: JSON.stringify({ body: "v2", expected_version: 1 }),
    });
    const updatedDoc = (await updated.json() as any).doc;
    expect(updatedDoc.compilation_run_id).not.toBe(run.id);
    expect(store.listProjectDocRevisions(doc.id).map((revision) => revision.compilationRunId)).toEqual([
      updatedDoc.compilation_run_id,
      run.id,
    ]);
  });

  it("publishes repository Wiki only for capable scoped tasks and accepts idempotent merge events", async () => {
    const store = createStore();
    const workspace = store.ensureLocalWorkspace();
    const repositoryUrl = "git@github.com:acme/publish.git";
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_publish", name: "publish", url: repositoryUrl, source: "github", default_branch: "main",
    }]);
    const { agent, autopilot } = configureRepositoryWikiAutomation(store);
    const revision = "c".repeat(40);
    const autopilotRun = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      repositoryId: "repo_publish",
      dedupeKey: `repo_publish:incremental_update:${revision}`,
      payload: { repository_wiki_repository_id: "repo_publish" },
    });
    const task = store.getTask(autopilotRun.taskId!)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const source = store.createKnowledgeSubmission({
      workspaceId: "local",
      repositoryId: "repo_publish",
      scope: "repository_wiki",
      sourceType: "agent",
      proposedPath: "overview.md",
      body: "raw repository facts",
      sourceTaskId: task.id,
      sourceIssueId: null,
      sourceRevision: revision,
      authorAgentId: agent.id,
    }).submission;
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const published = await app.request("/api/workspaces/local/repos/repo_publish/wiki/publish", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        submission_ids: [source.id],
        dedupe_key: "repo-publish-1",
        output: { action: "create", path: "overview.md", title: "Overview", body: "curated repository facts" },
      }),
    });
    expect(published.status).toBe(200);
    const result = await published.json() as any;
    const doc = store.getRepositoryWikiDocByRef("local", "repo_publish", "overview.md")!;
    expect(doc).toMatchObject({ sourceRevision: revision, compilationRunId: result.run.id });
    expect(store.listRepositoryWikiDocRevisions(doc.id)[0]?.compilationRunId).toBe(result.run.id);

    const project = store.createProject({
      title: "Repository publishing",
      resources: [{ resourceType: "github_repo", resourceRef: { url: repositoryUrl } }],
    });
    const issue = store.createIssue({ title: "Curate repository", projectId: project.id });
    const normal = store.createAgent({ name: "Normal", provider: "claude" });
    const normalTask = store.createTask({ agentId: normal.id, issueId: issue.id, prompt: "bypass" });
    const normalCredential = await store.createTaskAccessToken(normalTask, "local");
    const denied = await app.request("/api/workspaces/local/repos/repo_publish/wiki/publish", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${normalCredential.token}` },
      body: JSON.stringify({ submission_ids: [source.id], dedupe_key: "bypass", output: { action: "noop" } }),
    });
    expect(denied.status).toBe(403);

    const eventBody = {
      workspace_id: "local",
      repository_id: "repo_publish",
      change_request_id: "108",
      before_sha: "a".repeat(40),
      after_sha: "b".repeat(40),
      changed_files: ["src/a.ts", "src/b.ts"],
      canonical_scm_event_id: "scme_108",
    };
    const recordEvent = () => app.request("/api/knowledge/events/repository-merged", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer root-secret" },
      body: JSON.stringify(eventBody),
    });
    const firstEvent = await recordEvent();
    expect(firstEvent.status).toBe(202);
    const firstEventBody = await firstEvent.json() as any;
    const repeatedEvent = await recordEvent();
    expect(repeatedEvent.status).toBe(200);
    expect(await repeatedEvent.json()).toMatchObject({
      deduplicated: true,
      submission: { id: firstEventBody.submission.id },
      run: { id: firstEventBody.run.id },
    });
  });

  it("creates one Issue Done bundle and one repository merge run per after SHA", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const project = store.createProject({ title: "Completion" });
    const issue = store.createIssue({ title: "Finish", projectId: project.id });
    const agent = store.createAgent({ name: "Worker", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "finish" });
    store.createIssueSession(issue.id, { title: "Implementation" });
    const raw = store.createKnowledgeSubmission({
      workspaceId: "local", projectId: project.id, scope: "memory", sourceType: "agent",
      body: "raw fact", sourceTaskId: task.id, sourceIssueId: issue.id, authorAgentId: agent.id,
    }).submission;
    db!.run("UPDATE multiremi_tasks SET status = 'completed', result = ? WHERE id = ?", [JSON.stringify("final task result"), task.id]);
    store.updateIssue(issue.id, { status: "done" });
    store.updateIssue(issue.id, { status: "done" });
    const bundles = store.listKnowledgeSubmissions({ workspaceId: "local", projectId: project.id })
      .filter((submission) => submission.sourceType === "issue_completion");
    expect(bundles).toHaveLength(1);
    expect(JSON.parse(bundles[0]!.body)).toMatchObject({
      submission_ids: [raw.id],
      tasks: [expect.objectContaining({ id: task.id, result: "final task result" })],
    });

    const workspace = store.getWorkspace("local")!;
    store.updateWorkspaceRepositories(workspace.id, [{
      id: "repo_merge", name: "merge", url: "git@github.com:acme/merge.git", source: "github", default_branch: "main",
    }]);
    const input = {
      workspaceId: "local", repositoryId: "repo_merge", changeRequestId: "108",
      beforeSha: "a".repeat(40), afterSha: "b".repeat(40), changedFiles: ["b.ts", "a.ts"], canonicalEventId: "scm_event_108",
    };
    const firstMerge = store.recordRepositoryMergeKnowledgeEvent(input);
    const retryMerge = store.recordRepositoryMergeKnowledgeEvent(input);
    expect(retryMerge).toMatchObject({ deduplicated: true, run: { id: firstMerge.run.id }, submission: { id: firstMerge.submission.id } });
    expect(store.listKnowledgeRunSources(firstMerge.run.id).filter((source) => source.sourceType === "scm_event")).toHaveLength(1);
  });

  it("migrates legacy knowledge without deleting it and is retry-safe", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Legacy" });
    const legacyWiki = store.createProjectDoc(project.id, { kind: "wiki", title: "Legacy Wiki", body: "still readable" });
    const legacyMemory = store.createProjectDoc(project.id, { kind: "memory", title: "Legacy Memory", body: "still recalled" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const migrate = (mode: "dry_run" | "execute") => app.request("/api/knowledge/migrate-legacy", {
      method: "POST",
      headers: ROOT_JSON_HEADERS,
      body: JSON.stringify({ workspace_id: "local", project_id: project.id, [mode]: true, batch_size: 100 }),
    });
    const dryRun = await migrate("dry_run");
    expect(dryRun.status).toBe(200);
    const planned = await dryRun.json() as any;
    expect(planned).toMatchObject({ dry_run: true, succeeded: 0, skipped: 0, errors: 0 });
    expect(planned.total).toBeGreaterThanOrEqual(2);
    expect(store.listKnowledgeSubmissions({ workspaceId: "local", projectId: project.id })).toEqual([]);

    const execute = await (await migrate("execute")).json() as any;
    expect(execute).toMatchObject({ dry_run: false, total: planned.total, succeeded: planned.total, skipped: 0, errors: 0 });
    const retry = await (await migrate("execute")).json() as any;
    expect(retry).toMatchObject({ total: planned.total, succeeded: 0, skipped: planned.total, errors: 0 });
    expect(store.getProjectDoc(legacyWiki.id)?.body).toBe("still readable");
    expect(store.getProjectDoc(legacyMemory.id)?.body).toBe("still recalled");
  });
});
