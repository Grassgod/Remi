import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";

const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Project-bound Chat daemon startup", () => {
  for (const localDirectory of [false, true]) {
    it(localDirectory
      ? "injects the selected Project with zero eager Git in a user directory"
      : "starts Project Chat with a diagnostic when automatic repository sync fails", async () => {
      const root = mkdtempSync(join(tmpdir(), "multiremi-bound-project-chat-"));
      roots.push(root);
      const db = new Database(":memory:");
      databases.push(db);
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      const repoUrl = "https://example.test/catalog-only-repo.git";
      store.updateWorkspace("local", {
        settings: { github_enabled: false },
        repos: [{ id: "repo_bound_chat", name: "bound-chat", url: repoUrl, source: "github" }],
      });
      const daemonId = "daemon-chat-project";
      store.registerRuntime({ id: "rt_chat_project", name: "Chat Project runtime", provider: "claude", workspaceId: "local", daemonId });
      const localPath = join(root, "user-repo");
      if (localDirectory) mkdirSync(localPath);
      const project = store.createProject({
        title: "Selected Chat Project",
        instructions: "Follow these Chat Project instructions.",
        resources: [
          { resourceType: "github_repo", resourceRef: { url: repoUrl } },
          ...(localDirectory ? [{ resourceType: "local_directory" as const, resourceRef: { localPath, daemonId } }] : []),
        ],
      });
      store.createProjectDoc(project.id, { kind: "wiki", title: "Project guide", path: "guide.md", body: "Current Project Wiki." });
      const agent = store.createAgent({ name: "Chat Project worker", provider: "claude" });
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const sent = store.sendChatMessage(chat.id, { body: "Read this Project context." });
      expect(store.getTaskWithAgent(sent.task.id)).toMatchObject({
        issueId: null, chatProjectId: project.id, holdsWorkspace: true,
        repos: [{ url: repoUrl }],
        chatAutoCheckoutRepos: [{ url: repoUrl }],
      });
      const credential = await store.createAccessToken({ name: "Chat Project test daemon", type: "daemon", workspaceId: "local", daemonId });
      const server = startMultiremiServer({ store, scheduler: null, authToken: "chat-project-test", hostname: "127.0.0.1", port: 0 });
      let prompt = "";
      let cwd = "";
      let envProject: string | undefined;
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`, token: credential.token,
        daemonId, runtimeId: "rt_chat_project", runtimeName: "Chat Project runtime", provider: "claude", workspaceId: "local",
        once: true, daemonPort: 0, workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, ".repo-cache"),
        providerFactory: (options) => ({
          async *sendStream(message) {
            prompt = message;
            cwd = options.cwd!;
            envProject = options.env?.MULTIREMI_PROJECT_ID;
            yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Project received." }] } as any;
          },
          getLastResponse: () => ({ text: "Project received.", sessionId: "chat-project-session", requestId: "chat-project-request" }),
        }),
      });
      const sync = spyOn((daemon as any).repoCache, "sync").mockImplementation(async () => { throw new Error("Authentication failed for Project repository"); });
      const checkout = spyOn((daemon as any).repoCache, "createWorktree").mockImplementation(async () => { throw new Error("Unexpected eager repository checkout"); });
      try {
        await daemon.start();
        expect(store.getTask(sent.task.id)?.status).toBe("completed");
        if (localDirectory) {
          expect(sync).not.toHaveBeenCalled();
          expect(checkout).not.toHaveBeenCalled();
        } else {
          // MUL-310 now requires an automatic attempt for bound daemon-owned
          // Chat; the earlier zero-eager-Git contract still applies to user dirs.
          expect(sync).toHaveBeenCalledTimes(1);
          expect(sync.mock.calls[0]![0]).toBe("local");
          expect(sync.mock.calls[0]![1]).toEqual([{ url: repoUrl }]);
          expect(checkout).not.toHaveBeenCalled();
          expect(prompt).toContain("## Repository Availability Warnings");
          expect(prompt).toContain("Authentication failed for Project repository");
          expect(prompt).toContain("Chat can continue without these repositories");
          expect(prompt).toContain("run `remi repo checkout <repo-id>` explicitly");
        }
        expect(envProject).toBe(project.id);
        expect(cwd).toBe(localDirectory ? localPath : join(root, "workspaces", "chats", chat.id));
        expect(prompt).toContain("This Chat is bound to project: Selected Chat Project");
        expect(prompt).toContain("Follow these Chat Project instructions.");
        expect(prompt).toContain("## Available Repositories");
        expect(prompt).toContain(repoUrl);
        expect(prompt).toContain("remi memory search");
        expect(prompt).not.toContain("## Issue");
        if (localDirectory) {
          expect(prompt).toContain("Automatic repository checkout is disabled for this working directory");
          expect(prompt).toContain("Project Wiki has not been materialized in this working directory");
          expect(existsSync(join(cwd, "wiki"))).toBe(false);
          expect(existsSync(join(cwd, ".multiremi", "wiki-base"))).toBe(false);
          expect(existsSync(join(cwd, ".multiremi", "chat-repos.json"))).toBe(false);
          expect(existsSync(join(cwd, "catalog-only-repo"))).toBe(false);
          expect(JSON.parse(readFileSync(join(cwd, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
        } else {
          expect(prompt).toContain("Project Wiki is materialized in `./wiki`");
          expect(readFileSync(join(cwd, "wiki", "guide.md"), "utf8")).toBe("Current Project Wiki.\n");
        }
      } finally {
        sync.mockRestore();
        checkout.mockRestore();
        server.stop(true);
      }
    });
  }

  it("checks out explicit Project repos once and reuses the stable Chat branch after a daemon restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-chat-repo-reuse-"));
    roots.push(root);
    const db = new Database(":memory:");
    databases.push(db);
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const repoUrl = "https://example.test/explicit-chat-repo.git";
    const catalogOnlyUrl = "https://example.test/catalog-only.git";
    store.updateWorkspace("local", {
      settings: { github_enabled: false, co_authored_by_enabled: false },
      repos: [
        { id: "repo_explicit", name: "explicit-chat-repo", url: repoUrl, source: "github", default_branch: "main" },
        { id: "repo_catalog_only", name: "catalog-only", url: catalogOnlyUrl, source: "github", default_branch: "main" },
      ],
    });
    const sourcePath = join(root, "source");
    mkdirSync(sourcePath);
    git(sourcePath, ["init", "-b", "main"]);
    git(sourcePath, ["config", "user.email", "chat-repo-test@example.test"]);
    git(sourcePath, ["config", "user.name", "Chat Repo Test"]);
    writeFileSync(join(sourcePath, "README.md"), "Initial Project source.\n");
    git(sourcePath, ["add", "README.md"]);
    git(sourcePath, ["commit", "-m", "initial"]);
    const daemonId = "daemon-chat-repo-reuse";
    const runtimeId = "rt_chat_repo_reuse";
    store.registerRuntime({ id: runtimeId, name: "Chat repo runtime", provider: "claude", workspaceId: "local", daemonId });
    const project = store.createProject({
      title: "Automatic repositories",
      resources: [{ resourceType: "github_repo", resourceRef: { url: repoUrl } }],
    });
    const agent = store.createAgent({ name: "Chat repo worker", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const credential = await store.createAccessToken({ name: "Chat repo daemon", type: "daemon", workspaceId: "local", daemonId });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "chat-repo-test", hostname: "127.0.0.1", port: 0 });
    const chatPath = join(root, "workspaces", "chats", chat.id);
    const repoPath = join(chatPath, "explicit-chat-repo");
    const prompts: string[] = [];
    const cwds: string[] = [];
    const createDaemon = () => new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`, token: credential.token,
      daemonId, runtimeId, runtimeName: "Chat repo runtime", provider: "claude", workspaceId: "local",
      once: true, daemonPort: 0, workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, ".repo-cache"),
      providerFactory: (options) => ({
        async *sendStream(message) {
          prompts.push(message);
          cwds.push(options.cwd!);
          expect(readFileSync(join(repoPath, "README.md"), "utf8")).toBe("Initial Project source.\n");
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Repository ready." }] } as any;
        },
        getLastResponse: () => ({ text: "Repository ready.", sessionId: "stable-chat-repo-session", requestId: "chat-repo-request" }),
      }),
    });
    try {
      const first = store.sendChatMessage(chat.id, { body: "Read Project source." });
      const firstDaemon = createDaemon();
      const cache = (firstDaemon as any).repoCache;
      const sync = spyOn(cache, "sync").mockImplementation(async (workspaceId: string, repos: Array<{ url: string }>) => {
        expect(workspaceId).toBe("local");
        expect(repos.map((repo) => repo.url)).toEqual([repoUrl]);
        // Supply a real bare cache without external network access. All later
        // worktree creation, manifest checks, and reuse execute real Git code.
        const barePath = cache.barePath(workspaceId, repoUrl);
        mkdirSync(dirname(barePath), { recursive: true });
        git(root, ["clone", "--bare", sourcePath, barePath]);
        git(barePath, ["remote", "set-url", "origin", repoUrl]);
        return [{ repoUrl, status: "fresh", error: null }];
      });
      const checkout = spyOn(cache, "createWorktree");
      try {
        await firstDaemon.start();
        expect(store.getTask(first.task.id)?.status).toBe("completed");
        expect(sync).toHaveBeenCalledTimes(1);
        expect(checkout).toHaveBeenCalledTimes(1);
        expect(checkout.mock.calls[0]![0]).toMatchObject({
          repoUrl, branchName: `chat/${chat.id}`, reuseExisting: true, skipFetch: true,
        });
        expect(git(repoPath, ["branch", "--show-current"])).toBe(`chat/${chat.id}`);
        expect(prompts[0]).toContain(`at \`${repoPath}\` on branch \`chat/${chat.id}\``);
        expect(prompts[0]).toContain("already checked out on the Chat session branch");
        expect(prompts[0]).not.toContain(catalogOnlyUrl);
        expect(cache.lookup("local", catalogOnlyUrl)).toBeNull();
        expect(JSON.parse(readFileSync(join(chatPath, ".multiremi", "chat-repos.json"), "utf8")).entries).toEqual([
          { projectId: project.id, repoUrl, path: repoPath },
        ]);
      } finally {
        sync.mockRestore();
        checkout.mockRestore();
      }

      writeFileSync(join(repoPath, "uncommitted.txt"), "Keep this local work.\n");
      const second = store.sendChatMessage(chat.id, { body: "Continue without refreshing the repository." });
      const secondDaemon = createDaemon();
      const secondCache = (secondDaemon as any).repoCache;
      const secondSync = spyOn(secondCache, "sync").mockImplementation(async () => { throw new Error("Existing Chat checkout must not fetch again"); });
      const secondCheckout = spyOn(secondCache, "createWorktree");
      try {
        await secondDaemon.start();
        expect(store.getTask(second.task.id)?.status).toBe("completed");
        expect(secondSync).not.toHaveBeenCalled();
        expect(secondCheckout).toHaveBeenCalledTimes(1);
        expect(secondCheckout.mock.calls[0]![0]).toMatchObject({
          repoUrl, branchName: `chat/${chat.id}`, reuseExisting: true, skipFetch: true,
        });
        expect(git(repoPath, ["branch", "--show-current"])).toBe(`chat/${chat.id}`);
        expect(readFileSync(join(repoPath, "uncommitted.txt"), "utf8")).toBe("Keep this local work.\n");
        expect(cwds).toEqual([chatPath, chatPath]);
        expect(prompts).toHaveLength(2);
        expect(secondCache.lookup("local", catalogOnlyUrl)).toBeNull();
      } finally {
        secondSync.mockRestore();
        secondCheckout.mockRestore();
      }
    } finally {
      server.stop(true);
    }
  });

  for (const localDirectory of [true, false]) {
    for (const unavailable of ["archived", "deleted"] as const) {
      it(`cold-starts once after a completed ${localDirectory ? "local-directory" : "managed"} Chat's Project is ${unavailable}, preserving its files`, async () => {
        const root = mkdtempSync(join(tmpdir(), "multiremi-chat-unavailable-project-"));
        roots.push(root);
        const db = new Database(":memory:");
        databases.push(db);
        const store = new MultiremiStore(db);
        store.ensureLocalWorkspace();
        const repoUrl = "https://example.test/preserved-chat-repo.git";
        store.updateWorkspace("local", {
          settings: { github_enabled: false, co_authored_by_enabled: false },
          repos: [{ id: "repo_preserved", name: "preserved-chat-repo", url: repoUrl, source: "github", default_branch: "main" }],
        });
        const sourcePath = join(root, "user-repo");
        mkdirSync(sourcePath);
        git(sourcePath, ["init", "-b", "main"]);
        git(sourcePath, ["config", "user.email", "chat-preserve@example.test"]);
        git(sourcePath, ["config", "user.name", "Chat Preserve"]);
        writeFileSync(join(sourcePath, "README.md"), "Original source.\n");
        git(sourcePath, ["add", "README.md"]);
        git(sourcePath, ["commit", "-m", "initial"]);
        const daemonId = "daemon-chat-preserved";
        const runtimeId = "rt_chat_preserved";
        store.registerRuntime({ id: runtimeId, name: "Preserved Chat runtime", provider: "claude", workspaceId: "local", daemonId });
        const project = store.createProject({
          title: "Project before unavailability",
          instructions: "Use this private Project context.",
          resources: [
            { resourceType: "github_repo", resourceRef: { url: repoUrl } },
            ...(localDirectory ? [{ resourceType: "local_directory" as const, resourceRef: { localPath: sourcePath, daemonId } }] : []),
          ],
        });
        store.createProjectDoc(project.id, { kind: "wiki", title: "Guide", path: "guide.md", body: "Keep the old Wiki." });
        const agent = store.createAgent({ name: "Preserved Chat worker", provider: "claude" });
        const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
        const credential = await store.createAccessToken({ name: "Preserved Chat daemon", type: "daemon", workspaceId: "local", daemonId });
        const server = startMultiremiServer({ store, scheduler: null, authToken: "preserved-chat-test", hostname: "127.0.0.1", port: 0 });
        const chatPath = join(root, "workspaces", "chats", chat.id);
        const originalPath = localDirectory ? sourcePath : join(chatPath, "preserved-chat-repo");
        const seen: Array<{ cwd: string; sessionId: string | null; projectId: string | undefined; prompt: string }> = [];
        const runTurn = async (turn: number) => {
          const sent = store.sendChatMessage(chat.id, { body: `Run turn ${turn}.` });
          const daemon = new MultiremiDaemon({
            serverUrl: `http://127.0.0.1:${server.port}`, token: credential.token,
            daemonId, runtimeId, runtimeName: "Preserved Chat runtime", provider: "claude", workspaceId: "local",
            once: true, daemonPort: 0, workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, ".repo-cache"),
            providerFactory: (options) => ({
              async *sendStream(message, sendOptions) {
                seen.push({ cwd: options.cwd!, sessionId: sendOptions?.sessionId ?? null, projectId: options.env?.MULTIREMI_PROJECT_ID, prompt: message });
                yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Turn finished." }] } as any;
              },
              getLastResponse: () => ({ text: "Turn finished.", sessionId: turn === 0 ? "bound-project-provider" : "fallback-provider", requestId: `preserved-request-${turn}` }),
            }),
          });
          const cache = (daemon as any).repoCache;
          const sync = spyOn(cache, "sync").mockImplementation(async (workspaceId: string, repos: Array<{ url: string }>) => {
            if (localDirectory || turn !== 0) throw new Error("No Git sync is allowed for this Chat turn");
            expect(repos.map((repo) => repo.url)).toEqual([repoUrl]);
            const barePath = cache.barePath(workspaceId, repoUrl);
            mkdirSync(dirname(barePath), { recursive: true });
            git(root, ["clone", "--bare", sourcePath, barePath]);
            git(barePath, ["remote", "set-url", "origin", repoUrl]);
            return [{ repoUrl, status: "fresh", error: null }];
          });
          const checkout = spyOn(cache, "createWorktree");
          try {
            await daemon.start();
            expect(store.getTask(sent.task.id)?.status).toBe("completed");
            expect(seen).toHaveLength(turn + 1);
            expect(sync).toHaveBeenCalledTimes(!localDirectory && turn === 0 ? 1 : 0);
            expect(checkout).toHaveBeenCalledTimes(!localDirectory && turn === 0 ? 1 : 0);
          } finally {
            sync.mockRestore();
            checkout.mockRestore();
          }
        };
        try {
          await runTurn(0);
          expect(seen[0]).toMatchObject({ cwd: localDirectory ? sourcePath : chatPath, sessionId: null, projectId: project.id });
          expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: "bound-project-provider", workDir: localDirectory ? sourcePath : chatPath });
          writeFileSync(join(originalPath, "uncommitted.txt"), "Preserve this unpublished work.\n");
          const before = directoryContents(originalPath);
          const repoMetadata = localDirectory ? null : readFileSync(join(chatPath, ".multiremi", "chat-repos.json"), "utf8");
          const wikiBefore = localDirectory ? null : directoryContents(join(chatPath, "wiki"));
          if (localDirectory) {
            expect(JSON.parse(readFileSync(join(sourcePath, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
            expect(existsSync(join(sourcePath, "wiki"))).toBe(false);
          }
          if (unavailable === "archived") store.archiveProject(project.id);
          else db.run("DELETE FROM multiremi_projects WHERE id = ?", [project.id]);

          for (const turn of [1, 2]) {
            await runTurn(turn);
            expect(seen[turn]).toMatchObject({ cwd: chatPath, sessionId: turn === 1 ? null : "fallback-provider" });
            expect(seen[turn]!.projectId).toBeUndefined();
            expect(seen[turn]!.prompt).toStartWith(turn === 1 ? "# Bootstrap Prompt" : "# Delta Prompt");
            if (turn === 1) expect(seen[turn]!.prompt).toContain("Repositories are not fetched for Chat startup");
            expect(seen[turn]!.prompt).not.toContain("Use this private Project context.");
            expect(seen[turn]!.prompt).not.toContain("This Chat is bound to project:");
            expect(directoryContents(originalPath)).toEqual(before);
            expect(readFileSync(join(originalPath, "uncommitted.txt"), "utf8")).toBe("Preserve this unpublished work.\n");
            if (localDirectory) {
              // Compare the entire user directory, including Git files and
              // platform metadata. The old local-directory GC marker stays true.
              expect(JSON.parse(readFileSync(join(sourcePath, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
              expect(existsSync(join(chatPath, "wiki"))).toBe(false);
            } else {
              expect(readFileSync(join(chatPath, ".multiremi", "chat-repos.json"), "utf8")).toBe(repoMetadata!);
              expect(directoryContents(join(chatPath, "wiki"))).toEqual(wikiBefore!);
              expect(git(originalPath, ["branch", "--show-current"])).toBe(`chat/${chat.id}`);
            }
            expect(store.getChatSession(chat.id)).toMatchObject({
              projectId: project.id, sessionId: "fallback-provider", workDir: chatPath,
            });
          }
        } finally {
          server.stop(true);
        }
      });
    }
  }
});


describe("Project-bound Chat local-directory assignment changes", () => {
  it("retires an existing Chat's selected directory when only resource position changes, while new Chats adopt the new first directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-chat-directory-order-"));
    roots.push(root);
    const db = new Database(":memory:");
    databases.push(db);
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", { settings: { github_enabled: false }, repos: [] });
    const workspacesRoot = join(root, "workspaces");
    const directoryA = join(root, "user-directory-a");
    const directoryB = join(root, "user-directory-b");
    for (const directory of [directoryA, directoryB]) {
      mkdirSync(directory);
      writeFileSync(join(directory, "unpublished.bin"), Buffer.from([0, 255, 1, 128, 10]));
      symlinkSync("unpublished.bin", join(directory, "unpublished-link"));
    }
    const hosts = [
      { daemonId: "daemon-chat-order-a", runtimeId: "rt_chat_order_a" },
      { daemonId: "daemon-chat-order-b", runtimeId: "rt_chat_order_b" },
    ];
    const credentials = new Map<string, string>();
    for (const host of hosts) {
      store.registerRuntime({ id: host.runtimeId, name: host.runtimeId, provider: "claude", workspaceId: "local", daemonId: host.daemonId });
      const credential = await store.createAccessToken({ name: host.daemonId, type: "daemon", workspaceId: "local", daemonId: host.daemonId });
      credentials.set(host.runtimeId, credential.token);
    }
    const project = store.createProject({
      title: "Project with ordered host directories",
      resources: [
        { resourceType: "local_directory", position: 1, resourceRef: { localPath: directoryA, daemonId: hosts[0]!.daemonId } },
        { resourceType: "local_directory", position: 2, resourceRef: { localPath: directoryB, daemonId: hosts[1]!.daemonId } },
      ],
    });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Guide", path: "guide.md", body: "Do not materialize this Wiki in either user directory." });
    const resourceB = store.listProjectResources(project.id)[1]!;
    const agent = store.createAgent({ name: "Ordered directory worker", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const chatPath = join(workspacesRoot, "chats", chat.id);
    const server = startMultiremiServer({ store, scheduler: null, authToken: "directory-order-test", hostname: "127.0.0.1", port: 0 });
    const runTurn = async (chatId: string, turn: number) => {
      const sent = store.sendChatMessage(chatId, { body: `Run ordered directory turn ${turn}.` });
      // Follow the actual server route. The broken implementation routes to B
      // and genuinely writes there, rather than merely failing an affinity mock.
      const runtimeId = store.getTask(sent.task.id)?.runtimeId ?? hosts[0]!.runtimeId;
      const host = hosts.find((entry) => entry.runtimeId === runtimeId)!;
      expect(host).toBeDefined();
      let observed: { cwd: string; sessionId: string | null; prompt: string } | undefined;
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`, token: credentials.get(runtimeId)!,
        ...host, runtimeName: host.runtimeId, provider: "claude", workspaceId: "local",
        once: true, daemonPort: 0, workspacesRoot, repoCacheRoot: join(root, ".repo-cache"),
        providerFactory: (options) => ({
          async *sendStream(message, sendOptions) {
            observed = { cwd: options.cwd!, sessionId: sendOptions?.sessionId ?? null, prompt: message };
            yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Ordered directory turn finished." }] } as any;
          },
          getLastResponse: () => ({ text: "Ordered directory turn finished.", sessionId: turn === 0 ? "ordered-local-provider" : "ordered-managed-provider", requestId: `directory-order-request-${turn}` }),
        }),
      });
      const acquire = spyOn((daemon as any).localPathLocks, "acquire");
      const cache = (daemon as any).repoCache;
      const sync = spyOn(cache, "sync").mockImplementation(async () => { throw new Error("No repository sync is allowed for this Project without repositories"); });
      const checkout = spyOn(cache, "createWorktree").mockImplementation(async () => { throw new Error("No repository checkout is allowed for this Project without repositories"); });
      try {
        await daemon.start();
        expect(store.getTask(sent.task.id)?.status).toBe("completed");
        expect(observed).toBeDefined();
        expect(sync).not.toHaveBeenCalled();
        expect(checkout).not.toHaveBeenCalled();
        return { ...observed!, runtimeId, lockPaths: acquire.mock.calls.map((args) => args[0]) };
      } finally {
        acquire.mockRestore();
        sync.mockRestore();
        checkout.mockRestore();
      }
    };
    try {
      const first = await runTurn(chat.id, 0);
      expect(first).toMatchObject({ cwd: directoryA, sessionId: null, runtimeId: hosts[0]!.runtimeId });
      expect(first.lockPaths).toEqual([directoryA]);
      expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: "ordered-local-provider", workDir: directoryA });
      expect(JSON.parse(readFileSync(join(directoryA, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
      const beforeA = directoryContents(directoryA);
      const beforeB = directoryContents(directoryB);
      store.updateProjectResource(project.id, resourceB.id, { position: 0 });
      expect(store.listProjectResources(project.id)[0]!.id).toBe(resourceB.id);

      for (const turn of [1, 2]) {
        const result = await runTurn(chat.id, turn);
        expect(result.cwd).toBe(chatPath);
        expect(result.cwd).not.toBe(directoryB);
        expect(result.sessionId).toBe(turn === 1 ? null : "ordered-managed-provider");
        expect(result.prompt).toStartWith(turn === 1 ? "# Bootstrap Prompt" : "# Delta Prompt");
        expect(result.lockPaths).toEqual([]);
        expect(directoryContents(directoryA)).toEqual(beforeA);
        expect(directoryContents(directoryB)).toEqual(beforeB);
        for (const directory of [directoryA, directoryB]) {
          expect(existsSync(join(directory, "wiki"))).toBe(false);
          expect(existsSync(join(directory, ".multiremi", "wiki-base"))).toBe(false);
        }
        expect(JSON.parse(readFileSync(join(directoryA, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
        expect(store.getChatSession(chat.id)).toMatchObject({ workDir: chatPath, sessionId: "ordered-managed-provider" });
      }

      // The restriction belongs to the existing session's assignment history;
      // creation must still route a new Chat to the newly selected host and path.
      const newChat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const newFirst = await runTurn(newChat.id, 0);
      expect(newFirst).toMatchObject({ cwd: directoryB, sessionId: null, runtimeId: hosts[1]!.runtimeId });
      expect(newFirst.lockPaths).toEqual([directoryB]);
      expect(JSON.parse(readFileSync(join(directoryB, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
      expect(existsSync(join(directoryB, "wiki"))).toBe(false);
      expect(existsSync(join(directoryB, ".multiremi", "wiki-base"))).toBe(false);
      expect(directoryContents(directoryA)).toEqual(beforeA);
    } finally {
      server.stop(true);
    }
  });

  for (const insideWorkspacesRoot of [false, true]) {
    for (const mutation of ["delete", "path", "daemon"] as const) {
      it(`cold-starts once in its managed directory after local-directory ${mutation}, preserving the user directory ${insideWorkspacesRoot ? "inside" : "outside"} the workspaces root`, async () => {
        const root = mkdtempSync(join(tmpdir(), "multiremi-chat-directory-transition-"));
        roots.push(root);
        const db = new Database(":memory:");
        databases.push(db);
        const store = new MultiremiStore(db);
        store.ensureLocalWorkspace();
        store.updateWorkspace("local", { settings: { github_enabled: false }, repos: [] });
        const workspacesRoot = join(root, "workspaces");
        const userPath = join(insideWorkspacesRoot ? workspacesRoot : root, "user-owned-directory");
        const replacementPath = join(root, "replacement-user-directory");
        mkdirSync(userPath, { recursive: true });
        mkdirSync(replacementPath);
        writeFileSync(join(userPath, "unpublished.bin"), Buffer.from([0, 255, 1, 128, 10]));
        writeFileSync(join(replacementPath, "keep.txt"), "Do not enter this replacement directory.\n");
        symlinkSync("unpublished.bin", join(userPath, "unpublished-link"));
        symlinkSync(replacementPath, join(userPath, "external-directory-link"));
        const daemonId = "daemon-chat-local-transition";
        const runtimeId = "rt_chat_local_transition";
        const otherDaemonId = "daemon-chat-local-transition-other";
        store.registerRuntime({ id: runtimeId, name: "Directory transition runtime", provider: "claude", workspaceId: "local", daemonId });
        store.registerRuntime({ id: "rt_chat_local_transition_other", name: "Other directory runtime", provider: "claude", workspaceId: "local", daemonId: otherDaemonId });
        const project = store.createProject({
          title: "Active Project with changing directory",
          instructions: "This Project remains available after its directory changes.",
          resources: [{ resourceType: "local_directory", resourceRef: { localPath: userPath, daemonId } }],
        });
        store.createProjectDoc(project.id, { kind: "wiki", title: "Active guide", path: "guide.md", body: "Wiki must never be written into the old user directory." });
        const resource = store.listProjectResources(project.id).find((entry) => entry.resourceType === "local_directory")!;
        const agent = store.createAgent({ name: "Directory transition worker", provider: "claude" });
        const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
        const chatPath = join(workspacesRoot, "chats", chat.id);
        const credential = await store.createAccessToken({ name: "Directory transition daemon", type: "daemon", workspaceId: "local", daemonId });
        const server = startMultiremiServer({ store, scheduler: null, authToken: "directory-transition-test", hostname: "127.0.0.1", port: 0 });
        const seen: Array<{ cwd: string; sessionId: string | null; projectId: string | undefined; prompt: string }> = [];
        const runTurn = async (turn: number) => {
          const sent = store.sendChatMessage(chat.id, { body: `Run directory transition turn ${turn}.` });
          // Every turn starts a new daemon, so successful continuation cannot
          // depend on an in-memory directory or provider-session cache.
          const daemon = new MultiremiDaemon({
            serverUrl: `http://127.0.0.1:${server.port}`, token: credential.token,
            daemonId, runtimeId, runtimeName: "Directory transition runtime", provider: "claude", workspaceId: "local",
            once: true, daemonPort: 0, workspacesRoot, repoCacheRoot: join(root, ".repo-cache"),
            providerFactory: (options) => ({
              async *sendStream(message, sendOptions) {
                seen.push({ cwd: options.cwd!, sessionId: sendOptions?.sessionId ?? null, projectId: options.env?.MULTIREMI_PROJECT_ID, prompt: message });
                yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Directory turn finished." }] } as any;
              },
              getLastResponse: () => ({ text: "Directory turn finished.", sessionId: turn === 0 ? "local-directory-provider" : "managed-directory-provider", requestId: `directory-transition-request-${turn}` }),
            }),
          });
          const acquire = spyOn((daemon as any).localPathLocks, "acquire");
          const cache = (daemon as any).repoCache;
          const sync = spyOn(cache, "sync").mockImplementation(async () => { throw new Error("No repository sync should run for this Project without repositories"); });
          const checkout = spyOn(cache, "createWorktree").mockImplementation(async () => { throw new Error("No repository checkout should run for this Project without repositories"); });
          try {
            await daemon.start();
            expect(store.getTask(sent.task.id)?.status).toBe("completed");
            expect(seen).toHaveLength(turn + 1);
            expect(acquire).toHaveBeenCalledTimes(turn === 0 ? 1 : 0);
            expect(sync).not.toHaveBeenCalled();
            expect(checkout).not.toHaveBeenCalled();
          } finally {
            acquire.mockRestore();
            sync.mockRestore();
            checkout.mockRestore();
          }
        };
        try {
          await runTurn(0);
          expect(seen[0]).toMatchObject({ cwd: userPath, sessionId: null });
          expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: "local-directory-provider", workDir: userPath });
          expect(JSON.parse(readFileSync(join(userPath, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
          expect(existsSync(join(userPath, "wiki"))).toBe(false);
          expect(existsSync(join(userPath, ".multiremi", "wiki-base"))).toBe(false);
          const userBefore = directoryContents(userPath);
          const replacementBefore = directoryContents(replacementPath);
          if (mutation === "delete") store.deleteProjectResource(project.id, resource.id);
          else store.updateProjectResource(project.id, resource.id, {
            resourceRef: { localPath: mutation === "path" ? replacementPath : userPath, daemonId: mutation === "daemon" ? otherDaemonId : daemonId },
          });
          expect(store.getProject(project.id)?.archivedAt).toBeNull();
          expect(store.getChatSession(chat.id)?.projectId).toBe(project.id);

          for (const turn of [1, 2]) {
            await runTurn(turn);
            expect(seen[turn]).toMatchObject({ cwd: chatPath, sessionId: turn === 1 ? null : "managed-directory-provider", projectId: project.id });
            expect(seen[turn]!.prompt).toStartWith(turn === 1 ? "# Bootstrap Prompt" : "# Delta Prompt");
            if (turn === 1) expect(seen[turn]!.prompt).toContain("This Project remains available after its directory changes.");
            // Equality includes all metadata, arbitrary binary files, symlink
            // targets and structure. Never traverse a user-owned symlink.
            expect(directoryContents(userPath)).toEqual(userBefore);
            expect(directoryContents(replacementPath)).toEqual(replacementBefore);
            expect(JSON.parse(readFileSync(join(userPath, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
            expect(existsSync(join(userPath, "wiki"))).toBe(false);
            expect(existsSync(join(userPath, ".multiremi", "wiki-base"))).toBe(false);
            expect(store.getChatSession(chat.id)).toMatchObject({ projectId: project.id, workDir: chatPath, sessionId: "managed-directory-provider" });
          }
        } finally {
          server.stop(true);
        }
      });
    }
  }
});


describe("Daemon-only inherited Chat path rejection", () => {
  for (const inheritedPathKind of ["external directory", "managed alias to an external directory"] as const) {
    it(`retries a delta as a full bootstrap before any provider or user-directory write for an ${inheritedPathKind}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "multiremi-chat-unsafe-delta-"));
      roots.push(root);
      const db = new Database(":memory:");
      databases.push(db);
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      store.updateWorkspace("local", { settings: { github_enabled: false }, repos: [] });
      const workspacesRoot = join(root, "workspaces");
      const userPath = join(root, "private-user-directory");
      mkdirSync(join(userPath, ".multiremi"), { recursive: true });
      writeFileSync(join(userPath, ".multiremi", "gc.json"), JSON.stringify({ local_directory: true }));
      writeFileSync(join(userPath, "unpublished.bin"), Buffer.from([0, 255, 23, 128, 10]));
      symlinkSync("unpublished.bin", join(userPath, "unpublished-link"));
      const userBefore = directoryContents(userPath);
      const daemonId = "daemon-chat-unsafe-delta";
      const runtimeId = "rt_chat_unsafe_delta";
      store.registerRuntime({ id: runtimeId, name: "Unsafe delta runtime", provider: "claude", workspaceId: "local", daemonId });
      const project = store.createProject({ title: "Managed Project with stable resources" });
      const instructions = "Use these original agent instructions after a workspace recovery.";
      const agent = store.createAgent({ name: "Unsafe delta worker", provider: "claude", instructions });
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const chatPath = join(workspacesRoot, "chats", chat.id);
      const credential = await store.createAccessToken({ name: "Unsafe delta daemon", type: "daemon", workspaceId: "local", daemonId });
      const server = startMultiremiServer({ store, scheduler: null, authToken: "unsafe-delta-test", hostname: "127.0.0.1", port: 0 });
      const seen: Array<{ cwd: string; sessionId: string | null; prompt: string }> = [];
      let providerCreations = 0;
      const runDaemon = async (run: number, rejectInheritedPath = false) => {
        const daemon = new MultiremiDaemon({
          serverUrl: `http://127.0.0.1:${server.port}`, token: credential.token,
          daemonId, runtimeId, runtimeName: "Unsafe delta runtime", provider: "claude", workspaceId: "local",
          once: true, daemonPort: 0, workspacesRoot, repoCacheRoot: join(root, ".repo-cache"),
          providerFactory: (options) => {
            providerCreations++;
            return {
              async *sendStream(message, sendOptions) {
                seen.push({ cwd: options.cwd!, sessionId: sendOptions?.sessionId ?? null, prompt: message });
                yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: run === 0 ? "Earlier managed Chat answer." : "Recovered Chat answer." }] } as any;
              },
              getLastResponse: () => ({ text: run === 0 ? "Earlier managed Chat answer." : "Recovered Chat answer.", sessionId: run === 0 ? "safe-original-provider" : "safe-recovered-provider", requestId: `unsafe-delta-request-${run}` }),
            };
          },
        });
        const client = (daemon as any).client;
        const originalClaim = client.claimTask.bind(client);
        const claim = spyOn(client, "claimTask").mockImplementation(async (runtime: string) => {
          const task = await originalClaim(runtime);
          expect(task).not.toBeNull();
          if (rejectInheritedPath) {
            // The server's resources and persisted lineage remain unchanged.
            // Only this host sees an inherited path that no longer belongs to it.
            expect(task.sessionProjection?.mode).toBe("delta");
            expect(task.sessionId).toBe("safe-original-provider");
            expect(task.workDir).toBe(chatPath);
            return { ...task, workDir: inheritedPathKind === "external directory" ? userPath : join(workspacesRoot, "inherited-alias") };
          }
          if (run === 2) {
            expect(task.sessionProjection?.mode).toBe("bootstrap");
            expect(task.sessionId).toBeNull();
            expect(task.workDir).toBeNull();
          }
          return task;
        });
        const prepare = spyOn(daemon as any, "prepareTaskWorkspace");
        try {
          await daemon.start();
          if (rejectInheritedPath) expect(prepare).not.toHaveBeenCalled();
        } finally {
          claim.mockRestore();
          prepare.mockRestore();
        }
      };
      try {
        const first = store.sendChatMessage(chat.id, { body: "Earlier managed Chat message." });
        await runDaemon(0);
        expect(store.getTask(first.task.id)?.status).toBe("completed");
        expect(seen[0]).toMatchObject({ cwd: chatPath, sessionId: null });
        if (inheritedPathKind !== "external directory") symlinkSync(userPath, join(workspacesRoot, "inherited-alias"));
        const failed = store.sendChatMessage(chat.id, { body: "Recover this conversation safely." });
        const creationsBeforeFailure = providerCreations;
        await runDaemon(1, true);
        expect(providerCreations).toBe(creationsBeforeFailure);
        expect(seen).toHaveLength(1);
        expect(store.getTask(failed.task.id)).toMatchObject({ status: "failed", failureReason: "agent_error.stale_session" });
        expect(store.getChatSession(chat.id)).toMatchObject({ sessionId: null, workDir: null, sessionRuntimeId: null, sessionProvider: null, sessionExecutionFingerprint: null });
        expect(directoryContents(userPath)).toEqual(userBefore);
        const retries = store.listTasks().filter((task) => task.parentTaskId === failed.task.id);
        expect(retries).toHaveLength(1);
        expect(retries[0]).toMatchObject({ attempt: 2, sessionId: null, workDir: null });

        await runDaemon(2);
        expect(store.getTask(retries[0]!.id)?.status).toBe("completed");
        expect(seen).toHaveLength(2);
        expect(seen[1]).toMatchObject({ cwd: chatPath, sessionId: null });
        expect(seen[1]!.prompt).toStartWith("# Bootstrap Prompt");
        expect(seen[1]!.prompt).toContain(instructions);
        expect(seen[1]!.prompt).toContain('"body":"Earlier managed Chat message."');
        expect(seen[1]!.prompt).toContain('"body":"Earlier managed Chat answer."');
        expect(seen[1]!.prompt).toContain("Recover this conversation safely.");
        expect(directoryContents(userPath)).toEqual(userBefore);

        const continued = store.sendChatMessage(chat.id, { body: "Continue the recovered conversation." });
        await runDaemon(3);
        expect(store.getTask(continued.task.id)?.status).toBe("completed");
        expect(seen).toHaveLength(3);
        expect(seen[2]).toMatchObject({ cwd: chatPath, sessionId: "safe-recovered-provider" });
        expect(seen[2]!.prompt).toStartWith("# Delta Prompt");
        expect(directoryContents(userPath)).toEqual(userBefore);
        expect(JSON.parse(readFileSync(join(userPath, ".multiremi", "gc.json"), "utf8")).local_directory).toBe(true);
        expect(existsSync(join(userPath, "wiki"))).toBe(false);
        expect(existsSync(join(userPath, ".multiremi", "wiki-base"))).toBe(false);
      } finally {
        server.stop(true);
      }
    });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** Preserve structure and exact file bytes; never follow symlinks while comparing. */
function directoryContents(root: string): Array<{ path: string; kind: string; value?: string }> {
  const entries: Array<{ path: string; kind: string; value?: string }> = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) entries.push({ path: relativePath, kind: "symlink", value: readlinkSync(path) });
      else if (entry.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        visit(path, relativePath);
      } else entries.push({ path: relativePath, kind: "file", value: readFileSync(path).toString("base64") });
    }
  };
  visit(root, "");
  return entries;
}
