// The exact payload shapes the Go daemon expects from pending/claim polling,
// plus the issue-update paths that dispatch a task.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { configureRepositoryWikiAutomation, createStore, db, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — Go daemon wire shapes", () => {
  it("preserves repository Wiki hydration diagnostics through daemon claim normalization", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_wiki_diagnostic",
        name: "wiki-diagnostic",
        url: "https://github.com/example/wiki-diagnostic",
        source: "github",
        default_branch: "main",
      }],
    });
    const runtime = store.registerRuntime({
      id: "rt_wiki_diagnostic",
      name: "Wiki diagnostic runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const agent = store.createAgent({
      id: "agt_wiki_diagnostic",
      name: "Wiki diagnostic agent",
      provider: "codex",
      runtimeId: runtime.id,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Inspect repository Wiki" });
    const stored = store.createRepositoryWikiDoc("local", "repo_wiki_diagnostic", {
      title: "Architecture",
      path: "architecture.md",
      body: "last known good body",
    });
    const diagnostic = `Repository wiki body unavailable for ${stored.id}: object not found`;
    const hydrated = {
      ...store.getTaskWithAgent(task.id)!,
      repositoryWikiContexts: [{
        repository: {
          id: "repo_wiki_diagnostic",
          name: "wiki-diagnostic",
          url: "https://github.com/example/wiki-diagnostic",
          defaultBranch: "main",
        },
        docs: [{
          ...stored,
          body: "",
          status: "failed" as const,
          statusMessage: diagnostic,
          syncStatus: "failed" as const,
          syncError: diagnostic,
        }],
      }],
    };

    const wire = daemonTaskClaimResponse(store, hydrated, null);
    const wireDoc = (wire.repository_wiki_contexts as any[])[0].docs[0];
    expect(wireDoc).toMatchObject({
      id: stored.id,
      body: "",
      status: "failed",
      status_message: diagnostic,
      sync_status: "failed",
      sync_error: diagnostic,
    });

    mockFetch(() => jsonResponse({ task: wire }));
    const normalized = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);
    expect(normalized?.repositoryWikiContexts?.[0]?.docs[0]).toMatchObject({
      id: stored.id,
      body: "",
      status: "failed",
      statusMessage: diagnostic,
      syncStatus: "failed",
      syncError: diagnostic,
    });
  });

  it("lists daemon pending tasks like Go runtime polling", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_codex", name: "pending", provider: "codex", workspaceId: "local" });
    const otherRuntime = store.registerRuntime({ id: "rt_other_codex", name: "other", provider: "codex", workspaceId: "local" });
    const boundAgent = store.createAgent({ name: "Bound Codex", provider: "codex", runtimeId: runtime.id });
    const unboundAgent = store.createAgent({ name: "Unbound Codex", provider: "codex" });
    const otherBoundAgent = store.createAgent({ name: "Other Bound Codex", provider: "codex", runtimeId: otherRuntime.id });
    const issue = store.createIssue({ title: "Pending response parity", assigneeType: "agent", assigneeId: boundAgent.id });
    const high = store.createTask({ agentId: boundAgent.id, issueId: issue.id, workspaceId: "local", prompt: "high", priority: 100 });
    const sameOld = store.createTask({ agentId: boundAgent.id, workspaceId: "local", prompt: "same old", priority: 5 });
    const sameNew = store.createTask({ agentId: boundAgent.id, workspaceId: "local", prompt: "same new", priority: 5 });
    const low = store.createTask({ agentId: boundAgent.id, workspaceId: "local", prompt: "low", priority: 1 });
    const eligibleUnbound = store.createTask({ agentId: unboundAgent.id, workspaceId: "local", prompt: "eligible but unbound", priority: 99 });
    const otherBound = store.createTask({ agentId: otherBoundAgent.id, workspaceId: "local", prompt: "other runtime", priority: 20 });
    db!.run("UPDATE multiremi_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      sameOld.id,
    ]);
    db!.run("UPDATE multiremi_tasks SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:01.000Z",
      sameNew.id,
    ]);

    expect(store.claimTask(runtime.id)?.id).toBe(high.id);

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();
    expect(pendingBody.map((item: any) => item.id)).toEqual([high.id, sameOld.id, sameNew.id, low.id]);
    expect(pendingBody.map((item: any) => item.status)).toEqual(["dispatched", "queued", "queued", "queued"]);
    expect(Object.keys(pendingBody[0]).sort()).toEqual([
      "agent_id",
      "attempt",
      "completed_at",
      "created_at",
      "dispatched_at",
      "error",
      "execution_fingerprint",
      "holds_workspace",
      "id",
      "issue_id",
      "issue_session_generation",
      "issue_session_id",
      "kind",
      "max_attempts",
      "plugin_snapshot",
      "priority",
      "result",
      "runtime_id",
      "started_at",
      "status",
      "workspace_id",
    ]);
    expect(pendingBody[0]).toMatchObject({
      id: high.id,
      agent_id: boundAgent.id,
      runtime_id: runtime.id,
      issue_id: issue.id,
      // The daemon reads this to pick between the shared Issue root and a
      // discussion Session's private root, so it must survive the wire.
      holds_workspace: true,
      workspace_id: "local",
      status: "dispatched",
      priority: 100,
      started_at: null,
      completed_at: null,
      result: null,
      error: null,
      attempt: 1,
      max_attempts: 3,
      kind: "direct",
      plugin_snapshot: [],
    });
    expect(pendingBody[0].execution_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingBody[0].dispatched_at).toBeString();
    expect(pendingBody[0].created_at).toBeString();
    expect(pendingBody[0]).not.toHaveProperty("agentId");
    expect(pendingBody[0]).not.toHaveProperty("runtimeId");
    expect(pendingBody[1].kind).toBe("quick_create");
    expect(pendingBody.some((item: any) => item.id === eligibleUnbound.id)).toBe(false);
    expect(pendingBody.some((item: any) => item.id === otherBound.id)).toBe(false);
  });

  it("serves daemon claim responses in Go wire shape and normalizes them for the Bun daemon", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_claim_shape",
        name: "claim-shape",
        url: "https://github.com/example/claim-shape",
        source: "github",
        default_branch: "main",
      }],
    });
    // The runtime IS the machine that holds the project's local_directory
    // (daemon-claim), so the directory affinity resolves to it.
    const runtime = store.registerRuntime({ id: "rt_claim_shape", name: "claim shape", provider: "codex", workspaceId: "local", ownerId: "local", daemonId: "daemon-claim", maxConcurrency: 2 });
    const agent = store.createAgent({
      id: "agt_claim_shape",
      name: "Claim Shape Codex",
      provider: "codex",
      runtimeId: runtime.id,
      instructions: "Keep the claim shape stable.",
      customEnv: { CLAIM_SECRET: "present" },
      customArgs: ["--fast"],
      allowedTools: ["Read"],
      model: "gpt-5",
    });
    const project = store.createProject({
      id: "prj_claim_shape",
      title: "Claim project",
      description: "Project context",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/claim-shape", defaultBranchHint: "main" },
        label: "primary",
      }, {
        resourceType: "local_directory",
        resourceRef: { localPath: "/tmp/claim-local", daemonId: "daemon-claim", label: "local" },
        label: "local",
      }],
    });
    const issue = store.createIssue({
      id: "iss_claim_shape",
      title: "Claim shape issue",
      description: "Issue context",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.setIssueMetadataKey(issue.id, "target", "daemon-claim");
    const secondIssue = store.createIssue({
      id: "iss_claim_shape_second",
      title: "Second claim shape issue",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.setIssueMetadataKey(secondIssue.id, "target", "daemon-claim");
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "First claim" });
    const second = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Second claim" });
    const app = createMultiremiApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const claimTask = (await claim.json()).task;
    expect(claimTask).toMatchObject({
      id: first.id,
      agent_id: agent.id,
      runtime_id: runtime.id,
      issue_id: issue.id,
      issue_session_generation: 1,
      workspace_id: "local",
      status: "dispatched",
      prompt: "First claim",
      kind: "direct",
      agent: {
        id: agent.id,
        name: "Claim Shape Codex",
        provider: "codex",
        instructions: "Keep the claim shape stable.",
        custom_env: { CLAIM_SECRET: "present" },
        custom_args: ["--fast"],
        allowed_tools: ["Read"],
        model: "gpt-5",
        max_concurrent_tasks: 6,
      },
      issue: {
        id: issue.id,
        identifier: issue.key,
        workspace_id: "local",
        project_id: project.id,
        metadata: { target: "daemon-claim" },
      },
      project: {
        id: project.id,
        workspace_id: "local",
        title: "Claim project",
      },
      project_resources: [
        {
          resource_type: "github_repo",
          resource_ref: { url: "https://github.com/example/claim-shape", default_branch_hint: "main" },
        },
        {
          resource_type: "local_directory",
          resource_ref: { local_path: "/tmp/claim-local", daemon_id: "daemon-claim", label: "local" },
        },
      ],
      repos: [{ url: "https://github.com/example/claim-shape" }],
    });
    expect(claimTask.auth_token).toStartWith("mat_");
    const firstClaimToken = await store.verifyAccessToken(claimTask.auth_token);
    expect(firstClaimToken).toMatchObject({
      type: "task",
      taskId: first.id,
      agentId: agent.id,
      workspaceId: "local",
      userId: "local",
    });
    expect(store.listAccessTokens("local").some((token) => token.id === firstClaimToken?.id)).toBe(false);
    expect(claimTask.agentId).toBeUndefined();
    expect(claimTask.runtimeId).toBeUndefined();
    expect(claimTask.maxAttempts).toBeUndefined();
    expect(claimTask.authToken).toBeUndefined();
    expect(claimTask.projectResources).toBeUndefined();
    expect(claimTask.agent.customEnv).toBeUndefined();
    expect(claimTask.issue.workspaceId).toBeUndefined();
    expect(claimTask.project_resources[0].resourceRef).toBeUndefined();

    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const client = new MultiremiDaemonClient("https://remi.example");
    const normalized = await client.claimTask(runtime.id);
    expect(normalized).toMatchObject({
      id: second.id,
      agentId: agent.id,
      runtimeId: runtime.id,
      issueId: secondIssue.id,
      issueSessionGeneration: 1,
      workspaceId: "local",
      prompt: "Second claim",
      agent: {
        id: agent.id,
        customEnv: { CLAIM_SECRET: "present" },
        customArgs: ["--fast"],
        allowedTools: ["Read"],
        maxConcurrentTasks: 6,
      },
      issue: {
        id: secondIssue.id,
        workspaceId: "local",
        projectId: project.id,
        metadata: { target: "daemon-claim" },
      },
      project: {
        id: project.id,
        workspaceId: "local",
      },
      projectResources: [
        {
          resourceType: "github_repo",
          resourceRef: { url: "https://github.com/example/claim-shape", default_branch_hint: "main" },
        },
        {
          resourceType: "local_directory",
          resourceRef: { local_path: "/tmp/claim-local", daemon_id: "daemon-claim", label: "local" },
        },
      ],
      repos: [{ url: "https://github.com/example/claim-shape" }],
    });
    expect(normalized?.authToken).toStartWith("mat_");
  });

  it("carries issue and trigger comment attachments into actionable prompts", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_attachment_prompt",
      name: "Attachment prompt runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const agent = store.createAgent({
      id: "agt_attachment_prompt",
      name: "Attachment prompt agent",
      provider: "codex",
      runtimeId: runtime.id,
    });
    store.createAttachment({
      id: "att_issue_prompt",
      filename: "issue.png",
      url: "/api/attachments/att_issue_prompt/content",
      contentType: "image/png",
      sizeBytes: 123,
    });
    const issue = store.createIssue({
      title: "Read the screenshots",
      description: "![issue](/api/attachments/att_issue_prompt/content)",
    });
    const commentAttachment = store.createAttachment({
      id: "att_comment_prompt",
      filename: "comment.jpg",
      url: "/api/attachments/att_comment_prompt/content",
      contentType: "image/jpeg",
      sizeBytes: 456,
    });
    const trigger = store.createIssueComment(issue.id, {
      body: "The second screenshot has the failing state.",
      attachmentIds: [commentAttachment.id],
    });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      triggerCommentId: trigger.id,
      prompt: "Inspect both screenshots",
    });
    const app = createMultiremiApp({ store });
    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });

    const claimed = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);

    expect(claimed?.id).toBe(task.id);
    expect(claimed?.issue?.attachments).toEqual([
      expect.objectContaining({
        id: "att_issue_prompt",
        filename: "issue.png",
        contentType: "image/png",
        sizeBytes: 123,
      }),
    ]);
    expect(claimed?.triggerCommentAttachments).toEqual([
      expect.objectContaining({
        id: "att_comment_prompt",
        filename: "comment.jpg",
        contentType: "image/jpeg",
        sizeBytes: 456,
      }),
    ]);

    const prompt = buildTaskPrompt({
      ...claimed!,
      issue: {
        ...claimed!.issue!,
        description: `${claimed!.issue!.description}\n![fallback](/api/attachments/att_unlinked_fallback/content)`,
      },
      chatMessage: "A chat attachment is also available.",
      chatBootstrapTranscript: "[user]\nA chat attachment is also available.",
      chatMessageAttachments: [{
        id: "att_chat_prompt",
        filename: "chat.txt",
        content_type: "text/plain",
        size_bytes: 789,
      }],
    } as any);
    expect(prompt).toContain("id: att_issue_prompt; filename: issue.png; content-type: image/png; size: 123 bytes");
    expect(prompt).toContain("remi attachment download att_issue_prompt --output-dir <dir>");
    expect(prompt).toContain("id: att_comment_prompt; filename: comment.jpg; content-type: image/jpeg; size: 456 bytes");
    expect(prompt).toContain("remi attachment download att_comment_prompt --output-dir <dir>");
    expect(prompt).toContain("id: att_unlinked_fallback; filename: unavailable; content-type: unavailable; size: unavailable");
    expect(prompt).toContain("remi attachment download att_unlinked_fallback --output-dir <dir>");
    expect(prompt).toContain("id: att_chat_prompt; filename: chat.txt; content-type: text/plain; size: 789 bytes");
  });

  it("uses the latest Project Instructions when a queued task is first claimed", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_latest_project_instructions",
      name: "Latest Project Instructions runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const agent = store.createAgent({
      name: "Project Instructions worker",
      provider: "codex",
      runtimeId: runtime.id,
    });
    const project = store.createProject({
      title: "Mutable instructions project",
      instructions: "Use the instructions from task creation time.",
    });
    const issue = store.createIssue({
      title: "Queued before Project Instructions change",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      prompt: "Handle the queued task",
    });

    const latestInstructions = "Use the latest instructions available at first claim.";
    store.updateProject(project.id, { instructions: latestInstructions });
    const updatedProject = store.getProject(project.id)!;

    const app = createMultiremiApp({ store });
    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const claimed = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);

    expect(claimed?.id).toBe(task.id);
    expect(claimed?.project?.instructions).toBe(latestInstructions);
    expect(claimed?.project?.instructionsRevision).toBe(updatedProject.instructionsRevision);
    expect(claimed?.project?.instructionsUpdatedAt).toBe(updatedProject.instructionsUpdatedAt);
    const prompt = buildTaskPrompt(claimed);
    expect(prompt).toContain(`## Project Instructions\n${latestInstructions}`);
    expect(prompt).not.toContain("Use the instructions from task creation time.");
  });

  it("ships the latest Squad Instructions to the assigned leader at claim time", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_latest_squad_instructions",
      name: "Latest Squad Instructions runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const leader = store.createAgent({
      name: "Delivery leader",
      provider: "codex",
      runtimeId: runtime.id,
    });
    const teammate = store.createAgent({ name: "Delivery teammate", provider: "codex" });
    const squad = store.createSquad({
      name: "Delivery squad",
      leaderId: leader.id,
      memberIds: [teammate.id],
      instructions: "Use the instructions from task creation time.",
    });
    const issue = store.createIssue({
      title: "Queued before Squad Instructions change",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const task = store.createTask({
      agentId: leader.id,
      issueId: issue.id,
      prompt: "Lead the delivery",
    });

    const latestInstructions = "Open a draft PR early and summarize after the current round is complete.";
    store.updateSquad(squad.id, { instructions: latestInstructions });

    const app = createMultiremiApp({ store });
    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const claimed = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);

    expect(claimed?.id).toBe(task.id);
    expect(claimed?.squadContext).toMatchObject({
      id: squad.id,
      name: "Delivery squad",
      leaderAgentId: leader.id,
      instructions: latestInstructions,
    });
    const prompt = buildTaskPrompt(claimed!);
    expect(prompt).toContain(`## Squad Instructions\n${latestInstructions}`);
    expect(prompt).not.toContain("Use the instructions from task creation time.");
  });

  it("serves daemon claim execution context for chat, autopilot, and quick-create", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateCurrentUser({
      name: "Local Alice",
      profileDescription: "Prefers concise updates with verification notes.",
    });
    store.updateWorkspace("local", {
      context: "Use the workspace TypeScript conventions.",
      repos: [{
        id: "repo_claim_context",
        name: "claim-context",
        url: "https://github.com/example/claim-context",
        source: "github",
      }],
    });
    const runtime = store.registerRuntime({
      id: "rt_claim_context",
      name: "claim context",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
      maxConcurrency: 4,
    });
    const agent = store.createAgent({
      id: "agt_claim_context",
      name: "Atlas · LLM Wiki",
      provider: "claude",
      role: "maintainer",
      runtimeId: runtime.id,
    });
    const project = store.createProject({
      id: "prj_claim_context",
      title: "Claim Context Project",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "https://github.com/example/claim-context" },
      }],
    });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Claim chat context" });
    const firstChat = store.sendChatMessage(chat.id, { body: "Check Shanghai weather" });
    store.sendChatMessage(chat.id, { body: "and Qingdao too" });
    const autopilot = store.createAutopilot({
      id: "ap_claim_context",
      title: "Atlas · Repository Wiki",
      description: "Update the repository Wiki",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    configureRepositoryWikiAutomation(store, { agent, autopilot, runtimeId: runtime.id });
    const run = store.runAutopilot(autopilot.id, {
      source: "scm_event",
      payload: { repository_wiki_repository_id: "repo_claim_context", repository_wiki_mode: "incremental_update" },
      repositoryId: "repo_claim_context",
      dedupeKey: "repo_claim_context:incremental_update:abc123",
    });
    const quick = store.quickCreateIssue({
      agentId: agent.id,
      projectId: project.id,
      prompt: "Create onboarding screenshot follow-up",
    });
    const app = createMultiremiApp({ store });

    const claimed: any[] = [];
    for (let index = 0; index < 3; index++) {
      const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
      expect(claim.status).toBe(200);
      claimed.push((await claim.json()).task);
    }
    const byId = new Map(claimed.map((task) => [task.id, task]));

    expect(byId.get(firstChat.task.id)).toMatchObject({
      id: firstChat.task.id,
      kind: "chat",
      chat_session_id: chat.id,
      chat_message: "Check Shanghai weather\n\nand Qingdao too",
      workspace_context: "Use the workspace TypeScript conventions.",
      requesting_user_name: "Local Alice",
      requesting_user_profile_description: "Prefers concise updates with verification notes.",
    });
    expect(byId.get(firstChat.task.id).chatMessage).toBeUndefined();

    expect(byId.get(run.taskId!)).toMatchObject({
      id: run.taskId,
      kind: "autopilot",
      autopilot_run_id: run.id,
      autopilot_id: autopilot.id,
      autopilot_source: "scm_event",
      autopilot_title: "Atlas · Repository Wiki",
      autopilot_description: "Update the repository Wiki",
      autopilot_trigger_payload: { repository_wiki_repository_id: "repo_claim_context", repository_wiki_mode: "incremental_update" },
      scm_revision: "abc123",
    });
    expect(byId.get(run.taskId!).autopilotTitle).toBeUndefined();

    expect(byId.get(quick.task.id)).toMatchObject({
      id: quick.task.id,
      issue_id: quick.issue.id,
      project_id: project.id,
      quick_create_prompt: "Create onboarding screenshot follow-up",
    });
    expect(byId.get(quick.task.id).quickCreatePrompt).toBeUndefined();

    mockFetch(() => jsonResponse({
      task: {
        id: "tsk_norm_context",
        agent_id: agent.id,
        runtime_id: runtime.id,
        workspace_id: "local",
        status: "dispatched",
        priority: 0,
        prompt: "normalized context",
        attempt: 1,
        max_attempts: 3,
        result: null,
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
        kind: "chat",
        prior_session_id: "sess-prior",
        prior_work_dir: "/tmp/prior-work",
        chat_message: "Normalized chat",
        chat_bootstrap_transcript: "[user]\nCanonical chat",
        chat_message_attachments: [{ id: "att_1", filename: "brief.txt" }],
        autopilot_id: "ap_norm",
        autopilot_source: "webhook",
        autopilot_title: "Normalized autopilot",
        autopilot_description: "Normalized description",
        autopilot_trigger_payload: { ok: true },
        scm_revision: "deadbeef",
        quick_create_prompt: "Normalized quick-create",
        workspace_context: "Normalized workspace context",
        requesting_user_name: "Normalized Alice",
        requesting_user_profile_description: "Normalized requester profile",
      },
    }));
    const normalized = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);
    expect(normalized).toMatchObject({
      id: "tsk_norm_context",
      agentId: agent.id,
      runtimeId: runtime.id,
      priorSessionId: "sess-prior",
      priorWorkDir: "/tmp/prior-work",
      chatMessage: "Normalized chat",
      chatBootstrapTranscript: "[user]\nCanonical chat",
      chatMessageAttachments: [{ id: "att_1", filename: "brief.txt" }],
      autopilotId: "ap_norm",
      autopilotSource: "webhook",
      autopilotTitle: "Normalized autopilot",
      autopilotDescription: "Normalized description",
      autopilotTriggerPayload: { ok: true },
      scmRevision: "deadbeef",
      quickCreatePrompt: "Normalized quick-create",
      workspaceContext: "Normalized workspace context",
      requestingUserName: "Normalized Alice",
      requestingUserProfileDescription: "Normalized requester profile",
    });
  });

  it("claims a stale Chat retry with canonical product history instead of the dead session", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_stale_wire", name: "stale wire", provider: "claude" });
    const agent = store.createAgent({ name: "Stale Wire", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Recover" });
    const first = store.sendChatMessage(chat.id, { body: "Original question" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, {
      output: "Original answer",
      sessionId: "sess_stale_wire",
      workDir: "/tmp/stale-wire",
    });
    const resumed = store.sendChatMessage(chat.id, { body: "Continue from that" });
    expect(store.claimTask(runtime.id)?.id).toBe(resumed.task.id);
    store.startTask(resumed.task.id);
    store.failTask(resumed.task.id, {
      error: "Stale provider session: no conversation found",
      failureReason: "agent_error.stale_session",
    });

    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(response.status).toBe(200);
    const retry = (await response.json()).task;
    expect(retry).toMatchObject({
      parent_task_id: resumed.task.id,
      chat_session_id: chat.id,
    });
    expect(retry).not.toHaveProperty("session_id");
    expect(retry).not.toHaveProperty("work_dir");
    expect(retry.session_projection.mode).toBe("bootstrap");
    expect(retry.session_projection.jsonl).toContain("Original question");
    expect(retry.session_projection.jsonl).toContain("Original answer");
    expect(retry.session_projection.jsonl).not.toContain("Continue from that");
    expect(retry.chat_message).toBe("Continue from that");
    expect(retry).not.toHaveProperty("chat_bootstrap_transcript");
  });

  it("switches a bound Chat from bootstrap to delta and removes repeated static prompt bytes", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_chat_delta", name: "chat delta", provider: "codex" });
    const agent = store.createAgent({
      name: "Chat Delta",
      provider: "codex",
      instructions: "Follow the workspace rules.\n".repeat(400),
    });
    const skill = store.createSkill({
      name: "Large prompt skill",
      description: "Static bootstrap content",
      content: "Inspect the repository carefully.\n".repeat(400),
    });
    store.setAgentSkills(agent.id, { skillIds: [skill.id!] });
    const issue = store.createIssue({ title: "Bound delta", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, issueId: issue.id, title: "Bound delta" });
    const app = createMultiremiApp({ store });

    const first = store.sendChatMessage(chat.id, { body: "First bound request" });
    const firstResponse = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(firstResponse.status).toBe(200);
    const firstClaim = (await firstResponse.json()).task;
    expect(firstClaim.session_projection.mode).toBe("bootstrap");
    const firstPrompt = buildTaskPrompt({
      ...store.getTaskWithAgent(first.task.id)!,
      sessionProjection: firstClaim.session_projection,
      chatMessage: firstClaim.chat_message,
    } as any);
    expect(firstPrompt.match(/First bound request/g)).toHaveLength(1);
    expect(firstPrompt).toContain("## Agent Instructions");
    expect(firstPrompt).toContain("## Skills");

    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "First answer", sessionId: "sess_chat_delta" });
    const second = store.sendChatMessage(chat.id, { body: "Second bound request" });
    const secondResponse = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(secondResponse.status).toBe(200);
    const secondClaim = (await secondResponse.json()).task;
    expect(secondClaim.session_projection.mode).toBe("delta");
    const secondPrompt = buildTaskPrompt({
      ...store.getTaskWithAgent(second.task.id)!,
      sessionProjection: secondClaim.session_projection,
      chatMessage: secondClaim.chat_message,
    } as any);
    expect(secondPrompt).toContain("# Delta Prompt");
    expect(secondPrompt).toContain(`## Issue\nKey: ${issue.key}`);
    expect(secondPrompt.match(/Second bound request/g)).toHaveLength(1);
    expect(secondPrompt).not.toContain("## Agent Instructions");
    expect(secondPrompt).not.toContain("## Skills");
    expect(Buffer.byteLength(secondPrompt)).toBeLessThan(Buffer.byteLength(firstPrompt) / 2);
  });

  it("ships bound Issue caller ID for chat tasks and keeps task-owned Issues separate", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Caller ID agent", provider: "codex" });
    const issue = store.createIssue({ title: "Caller ID issue", workspaceId: "local" });
    const boundChat = store.createChatSession({
      agentId: agent.id,
      workspaceId: "local",
      title: "Bound topic",
    });
    const boundChatTask = store.sendChatMessage(boundChat.id, { body: "What is the status?" }).task;
    store.updateChatSession(boundChat.id, { issueId: issue.id });
    const boundTask = store.getTaskWithAgent(boundChatTask.id)!;
    const boundWire = daemonTaskClaimResponse(store, boundTask);

    expect(boundWire.bound_issue).toEqual({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
    });
    const boundPrompt = buildTaskPrompt({
      ...boundTask,
      boundIssue: boundWire.bound_issue,
    } as any);
    expect(boundPrompt).toContain("## Bound Issue");
    expect(boundPrompt).toContain(`This Feishu topic is bound to ${issue.key} — ${issue.title} (status: ${issue.status}).`);
    expect(boundPrompt).toContain("Do not treat these updates as the full picture.");
    expect(boundPrompt).toContain(`remi issue get ${issue.id} --output json`);
    expect(boundPrompt).toContain(`remi comment list ${issue.id} --recent 30 --output json`);
    expect(boundPrompt).not.toContain("--tail");

    const unboundChat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Unbound topic" });
    const unboundTask = store.sendChatMessage(unboundChat.id, { body: "No issue here" }).task;
    const unboundWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(unboundTask.id)!);
    expect(unboundWire).not.toHaveProperty("bound_issue");

    const ownedTask = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      chatSessionId: boundChat.id,
      workspaceId: "local",
      prompt: "Owned Issue work",
    });
    const ownedWire = daemonTaskClaimResponse(store, store.getTaskWithAgent(ownedTask.id)!);
    expect(ownedWire.bound_issue).toEqual({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
    });
  });

  it("keeps a real bound topic task from mutating its Issue or adding an automatic comment", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_bound_topic", name: "bound topic", provider: "codex" });
    const agent = store.createAgent({ name: "Bound topic agent", provider: "codex", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Real bound topic", workspaceId: "local" });
    const chat = store.createChatSession({
      agentId: agent.id,
      issueId: issue.id,
      workspaceId: "local",
      title: "Real bound topic",
    });
    const task = store.sendChatMessage(chat.id, { body: "Please summarize the topic" }).task;
    expect(task.issueId).toBe(issue.id);
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);

    const claimed = store.getTaskWithAgent(task.id)!;
    const wire = daemonTaskClaimResponse(store, claimed);
    expect(wire.bound_issue).toEqual({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
    });
    const prompt = buildTaskPrompt({ ...claimed, boundIssue: wire.bound_issue } as any);
    expect(prompt).toContain("## Bound Issue");
    expect(prompt).toContain(`remi issue get ${issue.id} --output json`);

    const initialStatus = store.getIssue(issue.id)?.status;
    store.startTask(task.id);
    store.completeTask(task.id, { output: "Topic summary" });

    expect(store.getIssue(issue.id)?.status).toBe(initialStatus);
    expect(store.listIssueComments(issue.id)).toHaveLength(0);
    expect(store.listIssueActivity(issue.id).length).toBeGreaterThan(0);
  });

  it("includes Go pending task optional chat, autopilot, and workdir fields", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_optional", name: "pending optional", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Claude Runtime", provider: "claude", runtimeId: runtime.id });
    const workdirTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "workdir", priority: 50 });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Pending chat" });
    const chatTask = store.sendChatMessage(chat.id, { body: "continue the chat" }).task;
    const autopilot = store.createAutopilot({
      title: "Pending autopilot",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(autopilot.id);
    const autopilotTask = store.getTask(run.taskId!)!;

    expect(store.claimTask(runtime.id)?.id).toBe(workdirTask.id);
    store.pinTaskSession(workdirTask.id, "sess-workdir", "/Users/alice/src/remi");

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();
    const byId = new Map(pendingBody.map((task: any) => [task.id, task]));

    expect(byId.get(workdirTask.id)).toMatchObject({
      id: workdirTask.id,
      status: "dispatched",
      kind: "quick_create",
      work_dir: "/Users/alice/src/remi",
      relative_work_dir: "src/remi",
    });
    expect(byId.get(chatTask.id)).toMatchObject({
      id: chatTask.id,
      chat_session_id: chat.id,
      kind: "chat",
      issue_id: "",
    });
    expect(byId.get(autopilotTask.id)).toMatchObject({
      id: autopilotTask.id,
      autopilot_run_id: run.id,
      kind: "autopilot",
      issue_id: "",
    });
  });

  it("matches Go relative_work_dir privacy edge cases", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_workdir_edges", name: "pending workdir edges", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Claude Runtime", provider: "claude", runtimeId: runtime.id });
    const envTaskId = "12345678-aaaa-bbbb-cccc-123456789abc";
    const envShort = envTaskId.replaceAll("-", "").slice(0, 8);
    const envRoot = store.createTask({
      id: envTaskId,
      agentId: agent.id,
      workspaceId: "local",
      prompt: "env root",
      workDir: `/tmp/multiremi/local/${envShort}/worktree`,
      priority: 50,
    });
    const linuxHome = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "linux home",
      workDir: "/home/alice",
      priority: 40,
    });
    const windowsHome = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "windows home",
      workDir: "C:\\Users\\Alice\\src\\repo",
      priority: 30,
    });
    const unknownMount = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "unknown mount",
      workDir: "/srv/shared/repo/",
      priority: 20,
    });
    const rootPath = store.createTask({
      agentId: agent.id,
      workspaceId: "local",
      prompt: "root path",
      workDir: "/",
      priority: 10,
    });

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();
    const byId = new Map(pendingBody.map((task: any) => [task.id, task]));

    expect(byId.get(envRoot.id)).toMatchObject({
      work_dir: `/tmp/multiremi/local/${envShort}/worktree`,
      relative_work_dir: `local/${envShort}/worktree`,
    });
    expect(byId.get(linuxHome.id)).toMatchObject({
      work_dir: "/home/alice",
    });
    expect(byId.get(linuxHome.id)).not.toHaveProperty("relative_work_dir");
    expect(byId.get(windowsHome.id)).toMatchObject({
      work_dir: "C:\\Users\\Alice\\src\\repo",
      relative_work_dir: "src/repo",
    });
    expect(byId.get(unknownMount.id)).toMatchObject({
      work_dir: "/srv/shared/repo/",
      relative_work_dir: "repo",
    });
    expect(byId.get(rootPath.id)).toMatchObject({
      work_dir: "/",
    });
    expect(byId.get(rootPath.id)).not.toHaveProperty("relative_work_dir");
  });

  it("marks comment-triggered pending tasks like Go", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_pending_comment", name: "pending comment", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Comment Bot", provider: "claude", runtimeId: runtime.id });
    const member = store.createWorkspaceMember({ id: "mem_alice", name: "Alice Reviewer", workspaceId: "local" });
    const issue = store.createIssue({ title: "Comment trigger", workspaceId: "local" });
    const previous = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "previous run" });
    const previousStartedAt = "2025-01-01T00:00:00.000Z";
    expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
    store.startTask(previous.id);
    db!.run("UPDATE multiremi_tasks SET started_at = ?, updated_at = ? WHERE id = ?", [previousStartedAt, previousStartedAt, previous.id]);
    store.completeTask(previous.id, { output: "done" });

    const root = store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: member.id,
      body: "Root discussion.",
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: agent.id,
      body: "Agent's own follow-up should not count.",
    });
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: member.id,
      body: "Another human follow-up.",
    });
    const body = `Please handle this [@Comment Bot](mention://agent/${agent.id}).`;
    const comment = store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: member.id,
      parentId: root.id,
      body,
    });
    const task = store.listTasks().find((item) => item.triggerCommentId === comment.id)!;

    expect(task.triggerCommentId).toBe(comment.id);
    expect(task.triggerSummary).toBe(body);

    const app = createMultiremiApp({ store });
    const pending = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/pending`);
    const pendingBody = await pending.json();

    expect(pendingBody).toHaveLength(1);
    expect(pendingBody[0]).toMatchObject({
      id: task.id,
      issue_id: issue.id,
      kind: "comment",
      trigger_comment_id: comment.id,
      trigger_summary: body,
      trigger_thread_id: root.id,
      trigger_comment_content: body,
      trigger_author_type: "member",
      trigger_author_name: "Alice Reviewer",
      new_comment_count: 2,
      new_comments_since: previousStartedAt,
    });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    const claimBody = await claim.json();
    expect(claimBody.task).toMatchObject({
      id: task.id,
      trigger_comment_id: comment.id,
      trigger_thread_id: root.id,
      trigger_comment_content: body,
      trigger_author_type: "member",
      trigger_author_name: "Alice Reviewer",
      new_comment_count: 2,
      new_comments_since: previousStartedAt,
    });
  });

  it("dispatches a task when an issue update assigns an agent (assign-on-update)", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_assign_update", name: "assign update", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Update Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Assign later", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const res = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_type: "agent", assignee_id: agent.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("todo");

    const tasks = store.listTasks().filter((task) => task.issueId === issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(agent.id);

    // Unrelated edits must not re-dispatch or cancel the running task.
    const rename = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Assign later (renamed)" }),
    });
    expect(rename.status).toBe(200);
    expect(store.listTasks().filter((task) => task.issueId === issue.id)).toHaveLength(1);
  });

  it("dispatches a task when an assigned backlog issue moves to an active status", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_backlog_update", name: "backlog update", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Backlog Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({
      title: "Parked work",
      workspaceId: "local",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    expect(store.listTasks().filter((task) => task.issueId === issue.id)).toHaveLength(0);
    const app = createMultiremiApp({ store });

    const res = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    expect(res.status).toBe(200);
    const tasks = store.listTasks().filter((task) => task.issueId === issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(agent.id);

    // Closing a backlog issue must NOT wake the agent.
    const parked = store.createIssue({
      title: "Parked forever",
      workspaceId: "local",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const close = await app.request(`/api/issues/${parked.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    expect(close.status).toBe(200);
    expect(store.listTasks().filter((task) => task.issueId === parked.id)).toHaveLength(0);
  });
});
