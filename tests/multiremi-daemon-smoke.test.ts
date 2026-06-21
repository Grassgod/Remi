import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AcpProviderOptions } from "../src/providers/acp/index.js";
import type { AgentResponse, SendOptions } from "../src/providers/base.js";
import { startMultiremiServer } from "../src/multiremi/api.js";
import {
  MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS,
  MultiremiDaemon,
  MultiremiRuntimeReregisterGate,
  type MultiremiDaemonProviderFactory,
} from "../src/multiremi/daemon.js";
import { MultiremiStore } from "../src/multiremi/store.js";

let db: Database | null = null;
let workDir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("Bun Multiremi daemon smoke", () => {
  it("coalesces runtime_gone re-register attempts like the Go daemon", () => {
    const gate = new MultiremiRuntimeReregisterGate();
    const t0 = 1_000_000;

    expect(gate.tryClaimRegisterSlot("local", t0, t0)).toBe(true);
    expect(gate.tryClaimRegisterSlot("local", t0 + 1, t0 + 1)).toBe(false);
    gate.recordRegisterCompletion("local", t0 + 50);
    expect(gate.tryClaimRegisterSlot("local", t0 + 10, t0 + 60)).toBe(false);
    expect(gate.tryClaimRegisterSlot("local", t0 + 100, t0 + 100)).toBe(true);

    const failedGate = new MultiremiRuntimeReregisterGate();
    expect(failedGate.tryClaimRegisterSlot("local", t0, t0)).toBe(true);
    failedGate.recordRegisterCompletion("local", t0 + 50, new Error("boom"));
    expect(failedGate.tryClaimRegisterSlot("local", t0 + 60, t0 + 50 + MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS / 2)).toBe(false);
    expect(failedGate.tryClaimRegisterSlot("local", t0 + 60, t0 + 50 + MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS + 1)).toBe(true);
  });

  it("runs one claimed task through the local API lifecycle", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-smoke-"));
    const store = new MultiremiStore(db);
    const agent = store.createAgent({
      name: "Claude Smoke",
      provider: "claude",
      model: "claude-smoke",
      allowedTools: ["Read"],
      customEnv: { SMOKE_ENV: "1" },
      cwd: workDir,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Say smoke from the daemon" });
    const daemonToken = await store.createAccessToken({
      name: "Smoke daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const expectedRuntimeId = daemonRuntimeIdForTest("daemon-smoke", "claude");
    store.registerRuntime({
      id: expectedRuntimeId,
      name: "smoke-runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-smoke-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const providerOptions: AcpProviderOptions[] = [];
    const prompts: string[] = [];
    const sendOptions: SendOptions[] = [];
    let closed = false;
    const response: AgentResponse = {
      text: "Smoke completed",
      sessionId: "sess-smoke",
      requestId: "req-smoke",
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 2,
      cacheCreateInputTokens: 1,
      model: "claude-smoke",
    };
    const providerFactory: MultiremiDaemonProviderFactory = (options) => {
      providerOptions.push(options);
      return {
        async *sendStream(message, options) {
          prompts.push(message);
          sendOptions.push(options ?? {});
          yield {
            sessionUpdate: "agent_thought_chunk",
            content: [{ type: "text", text: "Thinking" }],
          } as any;
          yield {
            sessionUpdate: "tool_call",
            title: "Read",
            rawInput: JSON.stringify({ path: "README.md" }),
            rawOutput: { content: "file body" },
          } as any;
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "Smoke " }],
          } as any;
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "completed" }],
          } as any;
          yield {
            sessionUpdate: "usage_update",
            model: "claude-smoke",
            inputTokens: 7,
            outputTokens: 3,
          } as any;
        },
        getLastResponse: () => response,
        close: async () => {
          closed = true;
        },
      };
    };

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-smoke",
        runtimeName: "smoke-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory,
      });

      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      expect(completed.runtimeId).toBe(expectedRuntimeId);
      expect(completed.result).toBe("Smoke completed");
      expect(completed.sessionId).toBe("sess-smoke");
      expect(completed.workDir).toBe(workDir);
      expect(store.getRuntime(expectedRuntimeId)?.daemonId).toBe("daemon-smoke");
      expect(providerOptions).toHaveLength(1);
      expect(providerOptions[0]).toMatchObject({
        agentType: "claude",
        model: "claude-smoke",
        allowedTools: ["Read"],
        cwd: workDir,
        env: { SMOKE_ENV: "1" },
      });
      const injectedToken = providerOptions[0].env?.MULTIREMI_TOKEN;
      expect(injectedToken).toStartWith("mat_");
      expect(injectedToken).not.toBe(daemonToken.token);
      expect(await store.verifyAccessToken(injectedToken!)).toBeNull();
      expect(prompts[0]).toContain("Say smoke from the daemon");
      expect(JSON.parse(readFileSync(join(workDir, ".multiremi", "task.json"), "utf-8"))).toMatchObject({
        task_id: task.id,
        workspace_id: "local",
        agent: {
          id: agent.id,
          provider: "claude",
        },
        prompt: "Say smoke from the daemon",
        repos: [],
      });
      expect(sendOptions[0]).toMatchObject({
        cwd: workDir,
        chatId: task.id,
        allowedTools: ["Read"],
        permissionMode: "default",
      });
      const messages = store.listTaskMessages(task.id);
      expect(messages.map((message) => ({
        seq: message.seq,
        type: message.type,
        tool: message.tool,
        content: message.content,
        input: message.input,
        output: message.output,
      }))).toEqual([
        { seq: 1, type: "thought", tool: null, content: "Thinking", input: null, output: null },
        { seq: 2, type: "tool", tool: "Read", content: null, input: { path: "README.md" }, output: "{\"content\":\"file body\"}" },
        { seq: 3, type: "assistant", tool: null, content: "Smoke ", input: null, output: null },
        { seq: 4, type: "assistant", tool: null, content: "completed", input: null, output: null },
        {
          seq: 5,
          type: "usage",
          tool: null,
          content: "{\"sessionUpdate\":\"usage_update\",\"model\":\"claude-smoke\",\"inputTokens\":7,\"outputTokens\":3}",
          input: null,
          output: null,
        },
      ]);
      expect(JSON.parse(messages[4].content ?? "{}")).toMatchObject({
        sessionUpdate: "usage_update",
        model: "claude-smoke",
        inputTokens: 7,
        outputTokens: 3,
      });
      const transcriptResponse = await fetch(`http://127.0.0.1:${server.port}/api/daemon/tasks/${task.id}/messages`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      });
      expect(transcriptResponse.status).toBe(200);
      const transcriptBody = await transcriptResponse.json() as any[];
      expect(transcriptBody).toEqual([
        { task_id: task.id, seq: 1, type: "thought", content: "Thinking" },
        { task_id: task.id, seq: 2, type: "tool", tool: "Read", input: { path: "README.md" }, output: "{\"content\":\"file body\"}" },
        { task_id: task.id, seq: 3, type: "assistant", content: "Smoke " },
        { task_id: task.id, seq: 4, type: "assistant", content: "completed" },
        {
          task_id: task.id,
          seq: 5,
          type: "usage",
          content: "{\"sessionUpdate\":\"usage_update\",\"model\":\"claude-smoke\",\"inputTokens\":7,\"outputTokens\":3}",
        },
      ]);
      expect(store.getTask(task.id)?.usage[0]).toMatchObject({
        provider: "claude",
        model: "claude-smoke",
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      });
      expect(store.listRuntimes()[0]).toMatchObject({
        name: "smoke-runtime",
        provider: "claude",
        status: "online",
      });
      expect(closed).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("serves repo checkout from the daemon cache to a running provider", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-repo-"));
    const sourceRepo = createSourceRepo(join(workDir, "_source", "repo"));
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { github_enabled: false, co_authored_by_enabled: true },
      repos: [{ url: sourceRepo, description: "local source repo" }],
    });
    const agent = store.createAgent({
      name: "Repo Claude",
      provider: "claude",
      cwd: workDir,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Check out the workspace repo" });
    const daemonToken = await store.createAccessToken({
      name: "Repo daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-repo-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    let checkoutPath = "";
    const prompts: string[] = [];
    const providerFactory: MultiremiDaemonProviderFactory = (options) => ({
      async *sendStream(message) {
        prompts.push(message);
        const env = options.env ?? {};
        const response = await fetch(`http://127.0.0.1:${env.MULTIREMI_DAEMON_PORT}/repo/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: sourceRepo,
            workspace_id: env.MULTIREMI_WORKSPACE_ID,
            workdir: options.cwd,
            agent_name: env.MULTIREMI_AGENT_NAME,
            task_id: env.MULTIREMI_TASK_ID,
          }),
        });
        expect(response.status).toBe(200);
        const result = await response.json() as { path: string; branch_name: string };
        checkoutPath = result.path;
        yield {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: `Checked out ${result.path}` }],
        } as any;
      },
      getLastResponse: () => ({
        text: `Checked out ${checkoutPath}`,
        sessionId: "sess-repo",
        requestId: "req-repo",
      }),
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "repo-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory,
      });

      await daemon.start();

      expect(checkoutPath).toBeTruthy();
      expect(existsSync(join(checkoutPath, "README.md"))).toBe(true);
      expect(readFileSync(join(checkoutPath, "README.md"), "utf8")).toContain("hello from repo");
      expect(execFileSync("git", ["-C", checkoutPath, "branch", "--show-current"], { encoding: "utf8" }).trim().startsWith("agent/repo-claude/")).toBe(true);
      expect(existsSync(prepareCommitMsgHookPath(checkoutPath))).toBe(false);
      expect(prompts[0]).toContain("## Available Repositories");
      expect(prompts[0]).toContain("multiremi repo checkout <url>");
      expect(prompts[0]).toContain(sourceRepo);
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(store.getTask(task.id)?.result).toContain("Checked out");
    } finally {
      server.stop(true);
    }
  });

  it("resumes chat tasks with the pinned provider session after daemon restart", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-chat-resume-"));
    const store = new MultiremiStore(db);
    const agent = store.createAgent({
      name: "Chat Claude",
      provider: "claude",
      cwd: workDir,
    });
    const session = store.createChatSession({ agentId: agent.id, title: "Resume chat" });
    const first = store.sendChatMessage(session.id, { body: "Start the chat" });
    const daemonToken = await store.createAccessToken({
      name: "Chat resume daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-chat-resume-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const prompts: string[] = [];
    const providerCwds: string[] = [];
    const sendOptions: SendOptions[] = [];
    let providerIndex = 0;
    const providerFactory: MultiremiDaemonProviderFactory = (options) => {
      const turn = providerIndex++;
      providerCwds.push(options.cwd);
      const text = turn === 0 ? "First answer" : "Second answer";
      return {
        async *sendStream(message, options) {
          prompts.push(message);
          sendOptions.push(options ?? {});
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text }],
          } as any;
        },
        getLastResponse: () => ({
          text,
          sessionId: turn === 0 ? "sess-chat-1" : "sess-chat-2",
          requestId: `req-chat-${turn + 1}`,
        }),
      };
    };
    const runDaemonOnce = () => new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "chat-resume-runtime",
      provider: "claude",
      workspaceId: "local",
      once: true,
      daemonPort: 0,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory,
    }).start();

    try {
      await runDaemonOnce();

      expect(store.getTask(first.task.id)?.status).toBe("completed");
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: "sess-chat-1",
        workDir,
        latestTaskId: first.task.id,
      });

      const second = store.sendChatMessage(session.id, { body: "Continue with the same provider session" });
      expect(second.task.sessionId).toBe("sess-chat-1");
      expect(second.task.workDir).toBe(workDir);

      await runDaemonOnce();

      expect(store.getTask(second.task.id)).toMatchObject({
        status: "completed",
        result: "Second answer",
        sessionId: "sess-chat-2",
        workDir,
      });
      expect(sendOptions).toHaveLength(2);
      expect(sendOptions[0].sessionId ?? null).toBeNull();
      expect(sendOptions[0]).toMatchObject({
        cwd: workDir,
        chatId: first.task.id,
      });
      expect(sendOptions[1]).toMatchObject({
        cwd: workDir,
        sessionId: "sess-chat-1",
        chatId: second.task.id,
      });
      expect(providerCwds).toEqual([workDir, workDir]);
      expect(prompts[0]).toContain("Start the chat");
      expect(prompts[1]).toContain("Continue with the same provider session");
      expect(store.listChatMessages(session.id).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: "sess-chat-2",
        workDir,
        latestTaskId: second.task.id,
      });
    } finally {
      server.stop(true);
    }
  });

  it("runs local_directory project tasks in the user directory", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-local-dir-"));
    const localDir = join(workDir, "local-project");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "README.md"), "local project\n");
    const store = new MultiremiStore(db);
    const project = store.createProject({
      title: "Local project",
      resources: [{
        resourceType: "local_directory",
        resourceRef: { localPath: localDir, daemonId: "daemon-local", label: "local project" },
      }],
    });
    const agent = store.createAgent({
      name: "Local Claude",
      provider: "claude",
    });
    const issue = store.createIssue({ title: "Use local directory", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Read the local project" });
    const daemonToken = await store.createAccessToken({
      name: "Local directory daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-local-dir-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    let providerCwd = "";
    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "local-dir-runtime",
        provider: "claude",
        workspaceId: "local",
        daemonId: "daemon-local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: (options) => ({
          async *sendStream() {
            providerCwd = options.cwd;
            yield {
              sessionUpdate: "agent_message_chunk",
              content: [{ type: "text", text: `cwd=${options.cwd}` }],
            } as any;
          },
          getLastResponse: () => ({
            text: `cwd=${providerCwd}`,
            sessionId: "sess-local-dir",
            requestId: "req-local-dir",
          }),
        }),
      });

      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(providerCwd).toBe(localDir);
      expect(completed.status).toBe("completed");
      expect(completed.workDir).toBe(localDir);
      expect(JSON.parse(readFileSync(join(localDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
        kind: "issue",
        task_id: task.id,
        issue_id: issue.id,
        local_directory: true,
      });
      expect(JSON.parse(readFileSync(join(localDir, ".multiremi", "project", "resources.json"), "utf8")).resources[0]).toMatchObject({
        resource_type: "local_directory",
        resource_ref: {
          local_path: localDir,
          daemon_id: "daemon-local",
        },
      });
    } finally {
      server.stop(true);
    }
  });

  it("does not fail a local_directory task cancelled while waiting for the lock", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-local-cancel-"));
    const localDir = join(workDir, "local-project");
    mkdirSync(localDir, { recursive: true });
    const store = new MultiremiStore(db);
    const runtime = store.registerRuntime({
      id: "rt_local_cancel",
      name: "Local cancel runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const project = store.createProject({
      title: "Local cancellation project",
      resources: [{
        resourceType: "local_directory",
        resourceRef: { localPath: localDir, daemonId: "daemon-local-cancel" },
      }],
    });
    const agent = store.createAgent({ name: "Local Cancel Claude", provider: "claude" });
    const firstIssue = store.createIssue({ title: "Hold local directory", projectId: project.id });
    const secondIssue = store.createIssue({ title: "Cancel while waiting", projectId: project.id });
    const firstTask = store.createTask({ agentId: agent.id, issueId: firstIssue.id, prompt: "Hold the directory" });
    const secondTask = store.createTask({ agentId: agent.id, issueId: secondIssue.id, prompt: "Wait for the directory" });
    const dispatchedAt = new Date().toISOString();
    db!.run("UPDATE multiremi_tasks SET status = 'dispatched', runtime_id = ?, dispatched_at = ?, updated_at = ? WHERE id IN (?, ?)", [
      runtime.id,
      dispatchedAt,
      dispatchedAt,
      firstTask.id,
      secondTask.id,
    ]);
    const daemonToken = await store.createAccessToken({
      name: "Local cancellation daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-local-cancel",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-local-cancel-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let secondProviderStarted = false;
    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "local-cancel-runtime",
        provider: "claude",
        workspaceId: "local",
        daemonId: "daemon-local-cancel",
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: (options) => {
          const taskId = String(options.env?.MULTIREMI_TASK_ID ?? "");
          return {
            async *sendStream() {
              if (taskId === firstTask.id) {
                firstStarted.resolve();
                await releaseFirst.promise;
                yield {
                  sessionUpdate: "agent_message_chunk",
                  content: [{ type: "text", text: "released" }],
                } as any;
                return;
              }
              secondProviderStarted = true;
              yield {
                sessionUpdate: "agent_message_chunk",
                content: [{ type: "text", text: "should not run" }],
              } as any;
            },
            getLastResponse: () => ({
              text: taskId === firstTask.id ? "released" : "should not run",
              sessionId: `sess-${taskId}`,
              requestId: `req-${taskId}`,
            }),
          };
        },
      });
      const handleTask = (daemon as unknown as {
        handleTask(task: ReturnType<MultiremiStore["getTaskWithAgent"]>): Promise<void>;
      }).handleTask.bind(daemon);

      const firstRun = handleTask(store.getTaskWithAgent(firstTask.id)!);
      await firstStarted.promise;
      const secondRun = handleTask(store.getTaskWithAgent(secondTask.id)!);
      await waitForCondition(() => store.getTask(secondTask.id)?.status === "waiting_local_directory");

      store.cancelTask(secondTask.id);
      await withTimeout(secondRun, 8_000, "second local_directory task did not stop after cancellation");

      expect(store.getTask(secondTask.id)).toMatchObject({
        status: "cancelled",
        error: null,
        failureReason: null,
      });
      expect(secondProviderStarted).toBe(false);

      releaseFirst.resolve();
      await firstRun;
      expect(store.getTask(firstTask.id)?.status).toBe("completed");
    } finally {
      releaseFirst.resolve();
      server.stop(true);
    }
  });

  it("reclaims daemon-owned workspace dirs from gc metadata", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-gc-"));
    const workspacesRoot = join(workDir, "workspaces");
    const store = new MultiremiStore(db);
    const agent = store.createAgent({
      name: "GC Claude",
      provider: "claude",
    });
    const completedIssue = store.createIssue({ title: "GC completed issue", workspaceId: "local" });
    const completedTask = store.createTask({
      agentId: agent.id,
      issueId: completedIssue.id,
      workspaceId: "local",
      prompt: "Create a daemon-owned directory",
    });
    const activeIssue = store.createIssue({ title: "GC active issue", workspaceId: "local" });
    const deletedChat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Deleted GC chat" });
    const daemonToken = await store.createAccessToken({
      name: "GC daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-gc-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "gc-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(workDir, ".repo-cache"),
        gcEnabled: false,
        gcTtlMs: 0,
        gcOrphanTtlMs: 1,
        providerFactory: () => ({
          async *sendStream() {
            yield {
              sessionUpdate: "agent_message_chunk",
              content: [{ type: "text", text: "GC completed" }],
            } as any;
          },
          getLastResponse: () => ({
            text: "GC completed",
            sessionId: "sess-gc",
            requestId: "req-gc",
          }),
        }),
      });

      await daemon.start();

      const completedDir = join(workspacesRoot, "local", completedTask.id);
      expect(existsSync(completedDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(completedDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
        kind: "issue",
        task_id: completedTask.id,
        issue_id: completedIssue.id,
        workspace_id: "local",
      });

      const oldIso = new Date(Date.now() - 10_000).toISOString();
      db!.run("UPDATE multiremi_issues SET status = 'done', updated_at = ? WHERE id = ?", [oldIso, completedIssue.id]);

      const activeDir = join(workspacesRoot, "local", "active-issue");
      writeGcFixture(activeDir, {
        kind: "issue",
        task_id: "task-active",
        issue_id: activeIssue.id,
        workspace_id: "local",
      });

      const chatDir = join(workspacesRoot, "local", "deleted-chat");
      writeGcFixture(chatDir, {
        kind: "chat",
        task_id: "task-chat",
        chat_session_id: deletedChat.id,
        workspace_id: "local",
      });
      db!.run("DELETE FROM multiremi_chat_sessions WHERE id = ?", [deletedChat.id]);

      const orphanDir = join(workspacesRoot, "local", "old-orphan");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "note.txt"), "stale orphan\n");
      const oldDate = new Date(Date.now() - 10_000);
      utimesSync(orphanDir, oldDate, oldDate);

      expect(await daemon.runGcOnce()).toEqual({ cleaned: 2, orphaned: 1, skipped: 1 });
      expect(existsSync(completedDir)).toBe(false);
      expect(existsSync(chatDir)).toBe(false);
      expect(existsSync(orphanDir)).toBe(false);
      expect(existsSync(activeDir)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("writes autopilot run metadata and reclaims terminal autopilot workdirs", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-autopilot-gc-"));
    const workspacesRoot = join(workDir, "workspaces");
    const store = new MultiremiStore(db);
    const agent = store.createAgent({
      name: "Autopilot GC Claude",
      provider: "claude",
    });
    const autopilot = store.createAutopilot({
      title: "Autopilot GC",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(autopilot.id);
    const daemonToken = await store.createAccessToken({
      name: "Autopilot GC daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-autopilot-gc-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "autopilot-gc-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(workDir, ".repo-cache"),
        gcEnabled: false,
        gcTtlMs: 0,
        providerFactory: () => ({
          async *sendStream() {
            yield {
              sessionUpdate: "agent_message_chunk",
              content: [{ type: "text", text: "Autopilot GC completed" }],
            } as any;
          },
          getLastResponse: () => ({
            text: "Autopilot GC completed",
            sessionId: "sess-autopilot-gc",
            requestId: "req-autopilot-gc",
          }),
        }),
      });

      await daemon.start();

      const taskDir = join(workspacesRoot, "local", run.taskId!);
      expect(existsSync(taskDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(taskDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
        kind: "autopilot_run",
        task_id: run.taskId,
        autopilot_run_id: run.id,
        workspace_id: "local",
      });

      const oldIso = new Date(Date.now() - 10_000).toISOString();
      db!.run("UPDATE multiremi_autopilot_runs SET completed_at = ? WHERE id = ?", [oldIso, run.id]);

      expect(await daemon.runGcOnce()).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
      expect(existsSync(taskDir)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("handles heartbeat maintenance requests for update, models, and local skills", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-maintenance-"));
    const skillsRoot = join(workDir, "skills");
    const skillDir = join(skillsRoot, "review-helper");
    const linkedSkillSource = join(workDir, "shared-skills", "linked-helper");
    const linkedSkillPath = join(skillsRoot, "linked-helper");
    const nestedSkillDir = join(skillsRoot, "team", "review", "deep", "helper");
    const tooDeepSkillDir = join(skillsRoot, "team", "review", "deep", "too", "far");
    mkdirSync(join(skillDir, "notes"), { recursive: true });
    mkdirSync(linkedSkillSource, { recursive: true });
    mkdirSync(nestedSkillDir, { recursive: true });
    mkdirSync(tooDeepSkillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Review Helper\ndescription: Review local changes\n---\n# Review Helper\n");
    writeFileSync(join(skillDir, "notes", "check.md"), "Check carefully\n");
    writeFileSync(join(skillDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]));
    writeFileSync(join(skillDir, "LICENSE"), "ignored\n");
    writeFileSync(join(linkedSkillSource, "SKILL.md"), "---\nname: Linked Helper\n---\n# Linked Helper\n");
    writeFileSync(join(nestedSkillDir, "SKILL.md"), "---\nname: Nested Helper\ndescription: Four level skill\n---\n# Nested Helper\n");
    writeFileSync(join(tooDeepSkillDir, "SKILL.md"), "---\nname: Too Deep Helper\n---\n# Too Deep Helper\n");
    symlinkSync(linkedSkillSource, linkedSkillPath, "dir");

    const runtimeId = "rt_daemon_maintenance";
    const store = new MultiremiStore(db);
    store.registerRuntime({ id: runtimeId, name: "maintenance-runtime", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({
      name: "Maintenance Claude",
      provider: "claude",
      cwd: workDir,
    });
    const queuedTask = store.createTask({ agentId: agent.id, prompt: "Do not claim before restart" });
    const updateRequest = store.createRuntimeUpdateRequest(runtimeId, { target_version: "v9.9.9" });
    const modelRequest = store.createRuntimeModelListRequest(runtimeId);
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtimeId);
    const importRequest = store.createRuntimeLocalSkillImportRequest(runtimeId, {
      skill_key: "review-helper",
      name: "Imported Review Helper",
    });
    const nestedImportRequest = store.createRuntimeLocalSkillImportRequest(runtimeId, {
      skill_key: "team/review/deep/helper",
    });
    const tooDeepImportRequest = store.createRuntimeLocalSkillImportRequest(runtimeId, {
      skill_key: "team/review/deep/too/far",
    });
    const daemonToken = await store.createAccessToken({
      name: "Maintenance daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-maintenance-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const updateTargets: string[] = [];
    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeId,
        runtimeName: "maintenance-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        localSkillRoots: { claude: skillsRoot },
        updateRunner: async (targetVersion) => {
          updateTargets.push(targetVersion);
          return `Updated to ${targetVersion}`;
        },
      });

      await daemon.start();

      expect(updateTargets).toEqual(["v9.9.9"]);
      expect(daemon.restartRequested()).toBe(true);
      expect(store.getTask(queuedTask.id)?.status).toBe("queued");
      expect(store.getRuntimeUpdateRequest(runtimeId, updateRequest.id)).toMatchObject({
        status: "completed",
        output: "Updated to v9.9.9",
      });
      expect(store.getRuntimeModelListRequest(runtimeId, modelRequest.id)).toMatchObject({
        status: "completed",
        supported: true,
      });
      expect(store.listRuntimeModels(runtimeId).map((model) => model.id)).toContain("claude-sonnet-4-6");

      const localSkillList = store.getRuntimeLocalSkillListRequest(runtimeId, localSkillRequest.id)!;
      expect(localSkillList.status).toBe("completed");
      expect(localSkillList.skills).toHaveLength(3);
      const skillsByKey = new Map(localSkillList.skills.map((skill) => [skill.key, skill]));
      expect(skillsByKey.get("review-helper")).toMatchObject({
        key: "review-helper",
        name: "Review Helper",
        description: "Review local changes",
        provider: "claude",
        fileCount: 2,
      });
      expect(skillsByKey.get("linked-helper")).toMatchObject({
        key: "linked-helper",
        name: "Linked Helper",
        provider: "claude",
        fileCount: 1,
      });
      expect(skillsByKey.get("team/review/deep/helper")).toMatchObject({
        key: "team/review/deep/helper",
        name: "Nested Helper",
        description: "Four level skill",
        provider: "claude",
        fileCount: 1,
      });
      expect(skillsByKey.has("team/review/deep/too/far")).toBe(false);

      const imported = store.getRuntimeLocalSkillImportRequest(runtimeId, importRequest.id)!;
      expect(imported.status).toBe("completed");
      expect(imported.skill?.name).toBe("Imported Review Helper");
      expect(imported.skill?.config?.origin).toMatchObject({
        type: "runtime_local",
        runtime_id: runtimeId,
        provider: "claude",
        source_path: skillDir,
      });
      expect(imported.skill?.files?.map((file) => file.path)).toEqual(["notes/check.md"]);
      const nestedImported = store.getRuntimeLocalSkillImportRequest(runtimeId, nestedImportRequest.id)!;
      expect(nestedImported.status).toBe("completed");
      expect(nestedImported.skill?.name).toBe("Nested Helper");
      expect(nestedImported.skill?.config?.origin).toMatchObject({
        type: "runtime_local",
        runtime_id: runtimeId,
        provider: "claude",
        source_path: nestedSkillDir,
      });
      const tooDeepImported = store.getRuntimeLocalSkillImportRequest(runtimeId, tooDeepImportRequest.id)!;
      expect(tooDeepImported.status).toBe("failed");
      expect(tooDeepImported.error).toBe("local skill key exceeds 4 directory levels");
      expect(tooDeepImported.skill).toBeNull();
      const metadata = store.getRuntime(runtimeId)?.metadata ?? {};
      expect(metadata.launched_by).toBe("manual");
      expect(typeof metadata.cli_version).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  it("refuses runtime update requests when the daemon is managed by Desktop", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-desktop-update-"));
    const runtimeId = "rt_daemon_desktop";
    const store = new MultiremiStore(db);
    store.registerRuntime({ id: runtimeId, name: "desktop-runtime", provider: "claude", workspaceId: "local" });
    const updateRequest = store.createRuntimeUpdateRequest(runtimeId, { target_version: "v9.9.10" });
    const daemonToken = await store.createAccessToken({
      name: "Desktop daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-desktop-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeId,
        runtimeName: "desktop-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        launchedBy: "desktop",
        updateRunner: () => {
          throw new Error("desktop-managed daemon should not self-update");
        },
      });

      await daemon.start();

      const failed = store.getRuntimeUpdateRequest(runtimeId, updateRequest.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("CLI is managed by Multiremi Desktop - update the Desktop app to upgrade the CLI");
      expect(store.getRuntime(runtimeId)?.metadata).toMatchObject({ launched_by: "desktop" });
    } finally {
      server.stop(true);
    }
  });

  it("serves local daemon health and shutdown for background lifecycle control", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-health-"));
    const store = new MultiremiStore(db);
    const daemonToken = await store.createAccessToken({
      name: "Lifecycle daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-lifecycle-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "lifecycle-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 25,
      repoCacheRoot: join(workDir, ".repo-cache"),
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      const port = await waitForLocalPort(daemon);
      const health = await waitForRunningHealth(port);

      expect(health).toMatchObject({
        status: "running",
        pid: process.pid,
        runtime_name: "lifecycle-runtime",
        provider: "claude",
        workspace_id: "local",
      });
      expect(typeof health.runtime_id).toBe("string");
      expect(typeof health.cli_version).toBe("string");

      const shutdown = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
      expect(shutdown.status).toBe(200);
      expect(await shutdown.json()).toEqual({ status: "shutting_down" });
      await daemonRun;
      expect(daemon.localPort()).toBe(0);
    } finally {
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("re-registers and continues when heartbeat reports runtime_gone", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-runtime-gone-"));
    const store = new MultiremiStore(db);
    const agent = store.createAgent({
      name: "Recovered Claude",
      provider: "claude",
      cwd: workDir,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Recover and continue" });
    const daemonToken = await store.createAccessToken({
      name: "Runtime gone daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const originalHeartbeat = store.heartbeatRuntime.bind(store);
    let injectedRuntimeGone = false;
    store.heartbeatRuntime = ((runtimeId, options) => {
      if (!injectedRuntimeGone) {
        injectedRuntimeGone = true;
        store.deleteRuntime(runtimeId);
      }
      return originalHeartbeat(runtimeId, options);
    }) as typeof store.heartbeatRuntime;
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-runtime-gone-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "runtime-gone-daemon",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: () => ({
          async *sendStream() {
            yield {
              sessionUpdate: "agent_message_chunk",
              content: [{ type: "text", text: "Recovered" }],
            } as any;
          },
          getLastResponse: () => ({
            text: "Recovered",
            sessionId: "sess-runtime-gone",
            requestId: "req-runtime-gone",
            inputTokens: 1,
            outputTokens: 1,
            model: "claude-recovered",
          }),
        }),
      });

      await daemon.start();

      expect(injectedRuntimeGone).toBe(true);
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(store.getTask(task.id)?.result).toBe("Recovered");
      expect(store.getTask(task.id)?.sessionId).toBe("sess-runtime-gone");
      const registeredEvents = store.listAnalyticsEvents({ name: "runtime_registered" });
      expect(registeredEvents).toHaveLength(2);
      expect(new Set(registeredEvents.map((event) => event.properties.runtime_id))).toHaveLength(1);
      expect(store.listRuntimes()).toHaveLength(1);
      expect(store.listRuntimes()[0]?.status).toBe("online");
    } finally {
      server.stop(true);
    }
  });

  it("fails a claimed task when provider execution times out", async () => {
    db = new Database(":memory:");
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-timeout-"));
    const store = new MultiremiStore(db);
    const agent = store.createAgent({
      name: "Timeout Claude",
      provider: "claude",
      cwd: workDir,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Hang forever" });
    const daemonToken = await store.createAccessToken({
      name: "Timeout daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-timeout-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "timeout-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        taskTimeoutMs: 10,
        providerFactory: () => ({
          async *sendStream(_message, options) {
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("Cancelled");
          },
          getLastResponse: () => null,
        }),
      });

      await daemon.start();

      const failed = store.getTask(task.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("Agent timed out after 10ms");
      expect(failed.failureReason).toBe("agent_error.agent_timeout");
    } finally {
      server.stop(true);
    }
  });
});

function daemonRuntimeIdForTest(daemonId: string, provider: string): string {
  const key = `${daemonId}:${provider}`.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rt_${(hash >>> 0).toString(36)}`;
}

function createSourceRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  runGit(path, ["init", "-b", "main"]);
  runGit(path, ["config", "user.email", "multiremi@example.com"]);
  runGit(path, ["config", "user.name", "Multiremi Test"]);
  writeFileSync(join(path, "README.md"), "hello from repo\n");
  runGit(path, ["add", "README.md"]);
  runGit(path, ["commit", "-m", "initial"]);
  return path;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    },
  });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    },
  }).trim();
}

function prepareCommitMsgHookPath(worktreePath: string): string {
  const commonDir = gitOutput(worktreePath, ["rev-parse", "--git-common-dir"]);
  return join(isAbsolute(commonDir) ? commonDir : join(worktreePath, commonDir), "hooks", "prepare-commit-msg");
}

function writeGcFixture(dir: string, payload: Record<string, unknown>): void {
  mkdirSync(join(dir, ".multiremi"), { recursive: true });
  writeFileSync(join(dir, ".multiremi", "gc.json"), JSON.stringify({ version: 1, ...payload }, null, 2));
}

async function waitForLocalPort(daemon: MultiremiDaemon): Promise<number> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const port = daemon.localPort();
    if (port > 0) return port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("daemon local port did not open");
}

async function waitForRunningHealth(port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1_500;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    last = await response.json() as Record<string, unknown>;
    if (last.status === "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon did not report running health: ${JSON.stringify(last)}`);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve as (value?: T | PromiseLike<T>) => void;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
