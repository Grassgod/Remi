import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
