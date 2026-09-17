import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    it(`injects the selected Project with zero eager Git in ${localDirectory ? "a user directory" : "the Chat directory"}`, async () => {
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
      const sync = spyOn((daemon as any).repoCache, "sync").mockImplementation(async () => { throw new Error("Unexpected eager repository sync"); });
      const checkout = spyOn((daemon as any).repoCache, "createWorktree").mockImplementation(async () => { throw new Error("Unexpected eager repository checkout"); });
      try {
        await daemon.start();
        expect(store.getTask(sent.task.id)?.status).toBe("completed");
        expect(sync).not.toHaveBeenCalled();
        expect(checkout).not.toHaveBeenCalled();
        expect(envProject).toBe(project.id);
        expect(cwd).toBe(localDirectory ? localPath : join(root, "workspaces", "chats", chat.id));
        expect(prompt).toContain("This Chat is bound to project: Selected Chat Project");
        expect(prompt).toContain("Follow these Chat Project instructions.");
        expect(prompt).toContain("## Available Repositories");
        expect(prompt).toContain(repoUrl);
        expect(prompt).toContain("remi memory search");
        expect(prompt).not.toContain("## Issue");
        if (localDirectory) {
          expect(prompt).toContain("Project Wiki has not been materialized in this working directory");
          expect(existsSync(join(cwd, "wiki"))).toBe(false);
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
});
