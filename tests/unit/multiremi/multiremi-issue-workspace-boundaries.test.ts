import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { IssueWorkspaceMoveError } from "@multiremi/store/repos/issues-repo.js";
import { readyArchiveBinding } from "./helpers.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { buildArchiveFixture } from "./session-archive-fixtures.js";

const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(backend === "PostgreSQL" && !pgUrl)(`MUL-476 workspace boundaries (${backend})`, () => {
    let db: Database | PostgresSyncDatabase;
    let store: MultiremiStore;
    let admin: Bun.SQL | undefined;
    let sessionArchives: SessionArchiveService;
    let archiveRoot: string;
    const databaseName = `mul476_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    let serial = 0;

    beforeAll(async () => {
      if (backend === "PostgreSQL") {
        admin = new Bun.SQL(pgUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(pgUrl!);
        url.pathname = `/${databaseName}`;
        db = new PostgresSyncDatabase(url.toString());
      } else {
        db = openSqliteDatabase(":memory:");
      }
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      archiveRoot = mkdtempSync(join(tmpdir(), "mul476-iw-archives-"));
      sessionArchives = new SessionArchiveService(store, { root: archiveRoot, maxBytes: 1024 * 1024, minFreeBytes: 0 });
    });

    afterAll(async () => {
      sessionArchives?.stopIssueArchivePurgeRecovery();
      await sessionArchives?.whenIssueArchivePurgeRecoveryIdle();
      db?.close();
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        await admin.end();
      }
      if (archiveRoot) rmSync(archiveRoot, { recursive: true, force: true });
    });

    function workspaces(reverse: boolean) {
      const suffix = `${backend.toLowerCase()}-${++serial}`;
      const a = store.createWorkspace({ id: `wsa_${suffix}`, name: `A ${suffix}`, slug: `a-${suffix}`, issuePrefix: "WA" });
      const b = store.createWorkspace({ id: `wsb_${suffix}`, name: `B ${suffix}`, slug: `b-${suffix}`, issuePrefix: "WB" });
      return reverse ? { source: b.id, target: a.id } : { source: a.id, target: b.id };
    }

    function moveError(action: () => unknown): IssueWorkspaceMoveError {
      try {
        action();
      } catch (err) {
        expect(err).toBeInstanceOf(IssueWorkspaceMoveError);
        return err as IssueWorkspaceMoveError;
      }
      throw new Error("Expected workspace_move_blocked");
    }

    async function credentials(source: string, target: string) {
      const app = createMultiremiApp({ store, sessionArchives, authToken: "mul476-test-root", shareSecret: "mul476-test-share" });
      async function member(both: boolean, home = source) {
        const user = store.getOrCreateUser({ email: `${home}-${both}@example.test`, name: both ? "Both workspaces" : "One workspace" });
        let memberId = "";
        for (const workspaceId of both ? [source, target] : [home]) {
          const row = store.createWorkspaceMember({ workspaceId, userId: user.id, name: user.name, role: "member" });
          if (workspaceId === home) memberId = row.id;
        }
        const token = (await store.createAccessToken({ type: "pat", workspaceId: home, userId: user.id, name: "Workspace boundary test" })).token;
        return { token, memberId, userId: user.id };
      }
      const sourceOnly = await member(false);
      const both = await member(true);
      const targetOnly = await member(false, target);
      const request = (token: string, path: string, method: string, body?: unknown) => app.request(path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { app, sourceOnly: sourceOnly.token, both: both.token, targetOnly: targetOnly.token,
        sourceMember: sourceOnly.memberId, targetMember: targetOnly.memberId, bothUser: both.userId,
        root: "mul476-test-root", request };
    }

    async function legacyTree(reverse: boolean) {
      const { source, target } = workspaces(reverse);
      const auth = await credentials(source, target);
      const parent = store.createIssue({ title: `PRIVATE parent ${source}`, workspaceId: source, status: "todo", createdBy: auth.bothUser });
      const agent = store.createAgent({ name: "Child agent", provider: "codex", workspaceId: source });
      const child = store.createIssue({ title: "Visible child", workspaceId: source, parentIssueId: parent.id,
        assigneeType: "agent", assigneeId: agent.id, createdBy: auth.bothUser });
      const task = store.createTask({ agentId: agent.id, issueId: child.id, workspaceId: source, prompt: "Child work" });
      const taskToken = (await store.createTaskAccessToken(task, store.getWorkspaceMember(auth.sourceMember)!.userId!)).token;
      db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target, parent.id]);
      return { source, target, auth, parent, child, agent, task, taskToken };
    }

    async function read(auth: Awaited<ReturnType<typeof credentials>>, token: string, path: string) {
      const response = await auth.request(token, path, "GET");
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    }

    async function shareBundle(auth: Awaited<ReturnType<typeof credentials>>, token: string, issueId: string) {
      const response = await auth.request(auth.both, `/api/issues/${issueId}/share`, "POST", {});
      expect(response.status).toBe(201);
      const body = await response.json();
      return read(auth, token, `/api/shares/${encodeURIComponent(body.share.token)}`);
    }

    function issueWorkspace(source: string, title = "Issue workspace", createdBy?: string) {
      const runtime = store.registerRuntime({ id: `rt_iw_${source}_${serial}`, name: `PRIVATE runtime ${source}`,
        workspaceId: source, provider: "codex", daemonId: `dmn_iw_${source}_${serial}`,
        metadata: { issue_workspaces: 1, parallel_execution: 1 } });
      store.updateDaemonDisplayName(source, runtime.daemonId!, `PRIVATE machine ${source}`, null);
      const issue = store.createIssue({ title, workspaceId: source, status: "done", createdBy });
      store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, status: "ready",
        rootPath: `/PRIVATE/${source}/${issue.key}`, branchName: `agent/${issue.key}`,
        repos: [{ repoName: "private-repo", repoUrl: `https://private.example/${source}/repo.git`,
          worktreePath: `/PRIVATE/${source}/repo`, branchName: `agent/${issue.key}`,
          baseRef: "main", status: "ready", dirty: false, error: null }] });
      return { issue, runtime };
    }

    function assertWorkspaceInvariant(issueId: string) {
      expect(db.query(`SELECT iw.issue_id FROM multiremi_issue_workspaces iw
        JOIN multiremi_issues i ON i.id = iw.issue_id
        WHERE iw.issue_id = ? AND iw.workspace_id <> i.workspace_id`).all(issueId)).toEqual([]);
    }

    async function physicalArchive(issueId: string, runtimeId: string) {
      const runtime = store.getRuntime(runtimeId)!;
      const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issueId }, traces: {} });
      const bytes = fixture.bytes;
      const initialized = sessionArchives.initialize({ workspaceId: runtime.workspaceId!, subjectKind: "issue", subjectId: issueId, issueId, runtimeId,
        daemonId: runtime.daemonId!, sourceRevision: fixture.sourceRevision,
        sha256: fixture.sha256, sizeBytes: bytes.byteLength }).archive;
      const claimed = await sessionArchives.claimUploadAttempt(runtimeId, issueId, initialized.id);
      await sessionArchives.upload(runtimeId, issueId, initialized.id, claimed.uploadAttempt!, new Response(fixture.bytes).body);
      const ready = await sessionArchives.complete(runtimeId, issueId, initialized.id, claimed.uploadAttempt!);
      return { archiveId: ready.id, sourceRevision: ready.sourceRevision, sha256: ready.sha256 };
    }

    async function completedTask(issueId: string, workspaceId: string) {
      const agent = store.createAgent({ name: "Completed worker", provider: "codex", workspaceId });
      const task = store.createTask({ issueId, agentId: agent.id, workspaceId, prompt: "Completed work" });
      db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [task.id]);
      store.updateIssue(issueId, { status: "done" });
      return task;
    }

    for (const reverse of [false, true]) {
      const direction = reverse ? "B -> A" : "A -> B";

      it(`${direction}: IW1 uncleaned Issue workspaces block HTTP moves without exposing foreign records`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const { issue, runtime } = issueWorkspace(source);
        const before = store.getIssueWorkspace(issue.id);
        const denied = await auth.request(auth.sourceOnly, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target });
        expect(denied.status).toBe(404);
        for (const status of ["preparing", "ready", "in_use", "dirty", "error", "runtime_offline"]) {
          db.run("UPDATE multiremi_issue_workspaces SET status = ? WHERE issue_id = ?", [status, issue.id]);
          const response = await auth.request(auth.both, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target });
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ code: "workspace_move_blocked",
            relations: { issue_workspace: { status, runtime_id: runtime.id }, hidden: 0 } });
          expect(store.getIssue(issue.id)?.workspaceId).toBe(source);
        }
        db.run("UPDATE multiremi_issue_workspaces SET status = 'ready', workspace_id = ? WHERE issue_id = ?", [target, issue.id]);
        const hidden = await auth.request(auth.both, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target });
        expect(hidden.status).toBe(409);
        const body = await hidden.json();
        expect(body.relations.issue_workspace).toBeNull();
        expect(body.relations.hidden).toBe(1);
        expect(JSON.stringify(body)).not.toContain(runtime.id);
        expect(store.getIssue(issue.id)?.workspaceId).toBe(source);
        db.run("UPDATE multiremi_issue_workspaces SET workspace_id = ? WHERE issue_id = ?", [source, issue.id]);
        expect(store.getIssueWorkspace(issue.id)).toEqual(before);
      });

      for (const cleanup of ["archive", "abandon"] as const) {
        it(`${direction}: IW2 ${cleanup} tombstone follows a move without machine fields`, async () => {
          const { source, target } = workspaces(reverse);
          const auth = await credentials(source, target);
          const { issue, runtime } = issueWorkspace(source);
          const task = await completedTask(issue.id, source);
          db.run("UPDATE multiremi_issue_workspaces SET last_task_id = ? WHERE issue_id = ?", [task.id, issue.id]);
          if (cleanup === "archive") {
            store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id,
              ...readyArchiveBinding(store, issue.id, runtime.id) });
          } else {
            db.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL WHERE issue_id = ?", [issue.id]);
            expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}/workspace/abandon`, "POST", {})).status).toBe(200);
          }
          const before = store.getIssueWorkspace(issue.id)!;
          const response = await auth.request(auth.both, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target });
          expect(response.status, await response.clone().text()).toBe(200);
          const moved = store.getIssue(issue.id)!;
          const tombstone = store.getIssueWorkspace(issue.id)!;
          expect(tombstone).not.toBeNull();
          expect(tombstone).toMatchObject({ workspaceId: target, issueKey: moved.key, runtimeId: null,
            lastTaskId: null, rootPath: "", branchName: "", repos: [], status: "cleaned" });
          for (const field of ["status", "cleanedAt", "cleanedArchiveId", "cleanedArchiveSourceRevision", "cleanedArchiveSha256", "createdAt"] as const) {
            expect(tombstone[field]).toBe(before[field]);
          }
          if (before.cleanedArchiveId) {
            expect(store.getSessionArchive(before.cleanedArchiveId)?.workspaceId).toBe(source);
          }
          assertWorkspaceInvariant(issue.id);
          const bundle = await read(auth, auth.targetOnly, `/api/issues/${issue.id}/workspace`);
          expect(bundle.workspace).toMatchObject({ status: "cleaned", runtime_id: null, runtime_name: null,
            runtime_status: null, runtime_provider: null, runtime_mode: null, runtime_device_info: null,
            runtime_daemon_id: null, runtime_machine_name: null, root_path: "", branch_name: "", repos: [] });
          expect(JSON.stringify(bundle)).not.toContain(`/PRIVATE/${source}`);
          expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}/workspace`, "GET")).status).toBe(404);
        });
      }

      it(`${direction}: IW3 source Runtime deletion cannot disclose a legacy moved Issue's title`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        store.updateWorkspaceMember(auth.sourceMember, { role: "admin" });
        const { issue, runtime } = issueWorkspace(source, `PRIVATE target title ${target}`);
        store.registerRuntime({ id: `${runtime.id}_sibling`, name: "Keep daemon alive", provider: "claude",
          workspaceId: source, daemonId: runtime.daemonId! });
        db.run("UPDATE multiremi_issues SET workspace_id = ?, issue_number = 999, issue_key = 'MUL-999' WHERE id = ?", [target, issue.id]);
        expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}`, "GET")).status).toBe(404);
        for (const token of [auth.sourceOnly, auth.targetOnly]) {
          const abandoned = await auth.request(token, `/api/issues/${issue.id}/workspace/abandon`, "POST", {});
          expect(abandoned.status).toBe(404);
          expect(await abandoned.text()).not.toContain(issue.title);
        }
        const response = await auth.request(auth.sourceOnly, `/api/runtimes/${runtime.id}`, "DELETE");
        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toMatchObject({ code: "runtime_has_active_issue_workspaces",
          issues: [{ id: issue.id, key: issue.key, title: issue.key, status: "ready" }] });
        expect(JSON.stringify(body)).not.toContain(issue.title);
        expect(JSON.stringify(body)).not.toContain("MUL-999");
        const deleted = await auth.request(auth.sourceOnly, `/api/runtimes/${runtime.id}?abandon_issue_workspaces=true`, "DELETE");
        expect(deleted.status, await deleted.clone().text()).toBe(200);
        expect(store.getRuntime(runtime.id)).toBeNull();
        expect(db.query("SELECT status, runtime_id FROM multiremi_issue_workspaces WHERE issue_id = ?").get(issue.id))
          .toEqual({ status: "cleaned", runtime_id: null });
      });

      for (const status of ["ready", "cleaned"] as const) {
        it(`${direction}: IW4 ${status} legacy records are absent from workspace and public share reads`, async () => {
          const { source, target } = workspaces(reverse);
          const auth = await credentials(source, target);
          const { issue, runtime } = issueWorkspace(source, "Issue workspace", auth.bothUser);
          db.run("UPDATE multiremi_issue_workspaces SET status = ? WHERE issue_id = ?", [status, issue.id]);
          db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target, issue.id]);
          expect(store.getIssueWorkspace(issue.id)).toBeNull();
          const workspace = await read(auth, auth.targetOnly, `/api/issues/${issue.id}/workspace`);
          expect(workspace.workspace).toBeNull();
          const shared = await shareBundle(auth, auth.targetOnly, issue.id);
          expect(shared.issue_workspace).toBeNull();
          for (const result of [workspace, shared]) {
            const encoded = JSON.stringify(result);
            for (const secret of [`/PRIVATE/${source}`, `private.example/${source}`, runtime.id, runtime.name,
              runtime.daemonId!, `PRIVATE machine ${source}`]) {
              expect(encoded).not.toContain(secret);
            }
          }
          expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}/workspace`, "GET")).status).toBe(404);
          expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}/share`, "POST", {})).status).toBe(404);
        });
      }

      it(`${direction}: IW5 target Runtime report takes over a legacy record and refreshes its key`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const { issue, runtime } = issueWorkspace(source);
        const daemon = (await store.createAccessToken({ type: "daemon", purpose: "daemon", workspaceId: source,
          daemonId: runtime.daemonId!, name: "Source daemon" })).token;
        const daemonOptions = { headers: { Authorization: `Bearer ${daemon}` }, authToken: "mul476-test-root", runtimeId: runtime.id, archives: sessionArchives };
        const reachable = await reportFrame(store, "gc.workspace_cleaned", { issue_id: issue.id, runtime_id: runtime.id }, daemonOptions);
        expect(reachable).toMatchObject({ ok: false, code: "invalid_report", operation_error: { status: 400 } });
        db.run("UPDATE multiremi_issues SET workspace_id = ?, issue_number = 999, issue_key = 'MUL-999' WHERE id = ?", [target, issue.id]);
        expect(() => store.initSessionArchive({ workspaceId: target, subjectKind: "issue", subjectId: issue.id, issueId: issue.id, runtimeId: runtime.id,
          daemonId: runtime.daemonId!, sourceRevision: "foreign-runtime", sha256: "f".repeat(64), sizeBytes: 0 },
          `sar_foreign_${issue.id}`, "foreign.tar.gz")).toThrow("Issue is deleting or its workspace has already been cleaned");
        expect(store.listSessionArchives(issue.id)).toEqual([]);
        const targetRuntime = store.registerRuntime({ id: `rt_target_${target}`, name: "Target Runtime", provider: "codex",
          workspaceId: target, daemonId: `dmn_target_${target}` });
        const input = { issueId: issue.id, runtimeId: targetRuntime.id, status: "ready" as const,
          rootPath: `/target/${target}`, branchName: "agent/MUL-999" };
        expect(store.reportIssueWorkspace(input)).toMatchObject({ workspaceId: target, issueKey: "MUL-999", runtimeId: targetRuntime.id });
        assertWorkspaceInvariant(issue.id);
        expect(() => store.reportIssueWorkspace({ ...input, runtimeId: runtime.id })).toThrow("runtime belongs to another workspace");
        const cleaned = await reportFrame(store, "gc.workspace_cleaned", { issue_id: issue.id, runtime_id: runtime.id,
          archive_id: "sar_source", source_revision: "source-revision", sha256: "f".repeat(64) }, daemonOptions);
        expect(cleaned).toMatchObject({ ok: false, code: "task_not_found", operation_error: { status: 404, code: "issue_not_found" } });
        expect(store.getIssueWorkspace(issue.id)).toMatchObject({ workspaceId: target, issueKey: "MUL-999", runtimeId: targetRuntime.id, status: "ready" });
      });

      it(`${direction}: IW6 legacy machine affinity does not pin a target workspace task`, () => {
        const { source, target } = workspaces(reverse);
        const { issue } = issueWorkspace(source);
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target, issue.id]);
        const targetRuntime = store.registerRuntime({ id: `rt_claim_${target}`, name: "Target machine", provider: "codex",
          workspaceId: target, daemonId: `dmn_claim_${target}`, metadata: { issue_workspaces: 1, parallel_execution: 1 } });
        const agent = store.createAgent({ name: "Target worker", provider: "codex", workspaceId: target });
        const session = store.createIssueSession(issue.id, { title: "Target work", holdsWorkspace: true });
        const task = store.createTask({ issueId: issue.id, issueSessionId: session.id,
          agentId: agent.id, workspaceId: target, prompt: "Use target machine" });
        const now = Date.now();
        db.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), task.id]);
        store.refreshQueuedCapabilityWaitReasons(now);
        expect(store.getTask(task.id)?.waitReason).toBeNull();
        expect(store.claimTask(targetRuntime.id)?.id).toBe(task.id);
        expect(store.getTask(task.id)?.runtimeId).toBe(targetRuntime.id);
        store.startTask(task.id);
        store.completeTask(task.id, { output: "Target turn finished", sessionId: `session_${target}` });
        const next = store.createTask({ issueId: issue.id, issueSessionId: session.id,
          agentId: agent.id, workspaceId: target, prompt: "Resume target turn" });
        expect(next).toMatchObject({ runtimeId: targetRuntime.id, sessionId: `session_${target}` });
        expect(store.claimTask(targetRuntime.id)?.id).toBe(next.id);
      });

      for (const evidence of ["archive", "abandon", "missing"] as const) {
        it(`${direction}: IW7 ${evidence} deletion gate gives the same result before and after moving`, async () => {
          const { source, target } = workspaces(reverse);
          const auth = await credentials(source, target);
          store.updateWorkspaceMember(auth.sourceMember, { role: "admin" });
          store.updateWorkspaceMember(auth.targetMember, { role: "admin" });
          async function prepared() {
            const { issue, runtime } = issueWorkspace(source);
            await completedTask(issue.id, source);
            if (evidence === "archive") {
              store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id,
                ...await physicalArchive(issue.id, runtime.id) });
            } else if (evidence === "abandon") {
              db.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL WHERE issue_id = ?", [issue.id]);
              expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}/workspace/abandon`, "POST", {})).status).toBe(200);
            } else {
              db.run("DELETE FROM multiremi_issue_workspaces WHERE issue_id = ?", [issue.id]);
            }
            return issue;
          }
          // Use equivalent Issues: a successful source deletion consumes its fixture.
          const original = await prepared();
          const before = await auth.request(auth.sourceOnly, `/api/issues/${original.id}`, "DELETE");
          const beforeBody = before.status === 204 ? {} : await before.json();
          const issue = await prepared();
          const moved = await auth.request(auth.both, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target });
          expect(moved.status, await moved.clone().text()).toBe(200);
          const after = await auth.request(auth.targetOnly, `/api/issues/${issue.id}`, "DELETE");
          const afterBody = after.status === 204 ? {} : await after.json();
          expect(after.status).toBe(before.status);
          expect(afterBody.code).toBe(beforeBody.code);
          if (evidence === "archive") {
            expect(after.status, JSON.stringify(afterBody)).toBe(204);
            expect(store.getIssue(issue.id)).toBeNull();
            expect(db.query("SELECT issue_id FROM multiremi_issue_workspaces WHERE issue_id = ?").get(issue.id)).toBeNull();
            expect(db.query("SELECT id FROM multiremi_session_archives WHERE issue_id = ?").all(issue.id)).toEqual([]);
          } else {
            expect(after.status).toBe(409);
            expect(afterBody.code).toBe(evidence === "abandon" ? "issue_workspace_archive_invalid" : "issue_workspace_not_cleaned");
            expect(store.getIssue(issue.id)?.workspaceId).toBe(target);
          }
        });
      }

      it(`${direction}: IW7 legacy cleanup in a foreign workspace cannot authorize hard deletion`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        store.updateWorkspaceMember(auth.targetMember, { role: "admin" });
        const { issue, runtime } = issueWorkspace(source);
        store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id,
          ...await physicalArchive(issue.id, runtime.id) });
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target, issue.id]);
        const response = await auth.request(auth.targetOnly, `/api/issues/${issue.id}`, "DELETE");
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "issue_workspace_not_cleaned" });
        expect(store.getIssue(issue.id)?.workspaceId).toBe(target);
        expect(store.listSessionArchives(issue.id)).toHaveLength(1);
      });

      it(`${direction}: IW8 abandoning an orphan workspace unblocks its move`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const { issue } = issueWorkspace(source);
        db.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL WHERE issue_id = ?", [issue.id]);
        expect((await auth.request(auth.both, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target })).status).toBe(409);
        expect((await auth.request(auth.sourceOnly, `/api/issues/${issue.id}/workspace/abandon`, "POST", {})).status).toBe(200);
        expect((await auth.request(auth.both, `/api/issues/${issue.id}`, "PATCH", { workspace_id: target })).status).toBe(200);
        expect(store.getIssueWorkspace(issue.id)).toMatchObject({ workspaceId: target, status: "cleaned", runtimeId: null, rootPath: "" });
        assertWorkspaceInvariant(issue.id);
      });

      it(`${direction}: refuses moving a parent with five children and a child with a parent`, () => {
        const { source, target } = workspaces(reverse);
        const parent = store.createIssue({ title: "Parent", workspaceId: source });
        const children = Array.from({ length: 5 }, (_, i) => store.createIssue({
          title: `Child ${i}`, workspaceId: source, parentIssueId: parent.id,
        }));
        const before = store.getIssue(parent.id);
        const err = moveError(() => store.updateIssue(parent.id, { workspace_id: target }));
        expect(err.code).toBe("workspace_move_blocked");
        expect(err.relations.children.sort()).toEqual(children.map((child) => child.key).sort());
        expect(store.getIssue(parent.id)).toEqual(before);
        const childError = moveError(() => store.updateIssue(children[0]!.id, { workspaceId: target }));
        expect(childError.relations.parent).toBe(parent.key);
        expect(store.getIssue(children[0]!.id)?.workspaceId).toBe(source);
      });

      it(`${direction}: requires detachment before moving and allows an unrelated leaf`, () => {
        const { source, target } = workspaces(reverse);
        const parent = store.createIssue({ title: "Parent", workspaceId: source });
        const child = store.createIssue({ title: "Child", workspaceId: source, parentIssueId: parent.id });
        moveError(() => store.updateIssue(child.id, { workspace_id: target, parent_issue_id: null }));
        store.updateIssue(child.id, { parent_issue_id: null });
        expect(store.updateIssue(child.id, { workspace_id: target }))
          .toMatchObject({ workspaceId: target, parentIssueId: null });
        const leaf = store.createIssue({ title: "Leaf", workspaceId: source });
        expect(store.updateIssue(leaf.id, { workspaceId: target }).workspaceId).toBe(target);
      });

      it.each(["blocked_by", "blocks", "related"] as const)(`${direction}: refuses moving either end of %s`, (type) => {
        const { source, target } = workspaces(reverse);
        const issue = store.createIssue({ title: "Issue", workspaceId: source });
        const other = store.createIssue({ title: "Other", workspaceId: source });
        const dep = store.createIssueDependency(issue.id, { dependsOnIssueId: other.id, type });
        for (const [endpoint, peer] of [[issue, other], [other, issue]]) {
          const err = moveError(() => store.updateIssue(endpoint!.id, { workspaceId: target }));
          expect(err.relations.dependencies).toEqual([{ id: dep.id, key: peer!.key, type: dep.type }]);
          expect(store.getIssue(endpoint!.id)?.workspaceId).toBe(source);
        }
      });

      it(`${direction}: batch preflight rejects every blocked row before moving any leaf`, () => {
        const { source, target } = workspaces(reverse);
        const parent = store.createIssue({ title: "Parent", workspaceId: source });
        const child = store.createIssue({ title: "Child", workspaceId: source, parentIssueId: parent.id });
        const leaf = store.createIssue({ title: "Leaf first in batch", workspaceId: source });
        const err = moveError(() => store.batchUpdateIssues({
          issue_ids: [leaf.id, parent.id, child.id], updates: { workspace_id: target },
        }));
        expect(err.issueIds).toEqual([parent.id, child.id]);
        for (const issue of [leaf, parent, child]) expect(store.getIssue(issue.id)?.workspaceId).toBe(source);
      });

      it(`${direction}: rejects creating or re-parenting to a foreign parent and adding a foreign dependency`, () => {
        const { source, target } = workspaces(reverse);
        const issue = store.createIssue({ title: "Issue", workspaceId: source });
        const foreign = store.createIssue({ title: "Foreign", workspaceId: target });
        expect(() => store.createIssue({ title: "Invalid child", workspaceId: source, parentIssueId: foreign.id })).toThrow();
        expect(() => store.updateIssue(issue.id, { parentIssueId: foreign.id })).toThrow();
        expect(() => store.createIssueDependency(issue.id, { dependsOnIssueId: foreign.id, type: "related" })).toThrow();
        expect(store.getIssue(issue.id)?.parentIssueId).toBeNull();
        expect(store.listIssueDependencies(issue.id)).toEqual([]);
      });

      it(`${direction}: raw foreign relationships block resurrection without exposing their keys`, () => {
        const { source, target } = workspaces(reverse);
        const parent = store.createIssue({ title: "Foreign parent", workspaceId: source });
        const child = store.createIssue({ title: "Child", workspaceId: source, parentIssueId: parent.id });
        const other = store.createIssue({ title: "Foreign dependency", workspaceId: source });
        store.createIssueDependency(child.id, { dependsOnIssueId: other.id, type: "related" });
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id IN (?, ?)", [target, parent.id, other.id]);
        const childError = moveError(() => store.updateIssue(child.id, { workspaceId: target }));
        expect(childError.relations).toEqual({ parent: null, children: [], dependencies: [], tasks: [], issue_workspace: null, hidden: 2 });
        const parentError = moveError(() => store.updateIssue(parent.id, { workspaceId: source }));
        expect(parentError.relations).toEqual({ parent: null, children: [], dependencies: [], tasks: [], issue_workspace: null, hidden: 1 });
        expect(store.getIssue(child.id)?.workspaceId).toBe(source);
      });

      for (const [method, prefix] of [["PATCH", "/api/multiremi/issues"], ["PATCH", "/api/issues"], ["PUT", "/api/issues"]]) {
        it(`${direction}: HTTP ${method} ${prefix} authorizes the target before refusing parent/child moves`, async () => {
          const { source, target } = workspaces(reverse);
          const auth = await credentials(source, target);
          const parent = store.createIssue({ title: "HTTP parent", workspaceId: source });
          const children = Array.from({ length: 5 }, (_, i) => store.createIssue({
            title: `HTTP child ${i}`, workspaceId: source, parentIssueId: parent.id,
          }));
          for (const issue of [parent, children[0]!]) {
            const denied = await auth.request(auth.sourceOnly, `${prefix}/${issue.id}`, method!, { workspace_id: target });
            expect(denied.status).toBe(404);
            expect(await denied.json()).not.toHaveProperty("relations");
            for (const token of [auth.both, auth.root]) {
              const refused = await auth.request(token, `${prefix}/${issue.id}`, method!, { workspace_id: target });
              expect(refused.status).toBe(409);
              const body = await refused.json();
              expect(body.code).toBe("workspace_move_blocked");
              if (issue.id === parent.id) expect(body.relations.children.sort()).toEqual(children.map((child) => child.key).sort());
              else expect(body.relations.parent).toBe(parent.key);
            }
            expect(store.getIssue(issue.id)?.workspaceId).toBe(source);
          }
        });
      }

      it(`${direction}: HTTP detachment must precede a move and leaf moves require target membership`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const parent = store.createIssue({ title: "Detach parent", workspaceId: source });
        const child = store.createIssue({ title: "Detach child", workspaceId: source, parentIssueId: parent.id });
        expect((await auth.request(auth.sourceOnly, `/api/issues/${child.id}`, "PATCH", { workspace_id: target, parent_issue_id: null })).status).toBe(404);
        expect((await auth.request(auth.both, `/api/issues/${child.id}`, "PATCH", { workspace_id: target, parent_issue_id: null })).status).toBe(409);
        expect((await auth.request(auth.sourceOnly, `/api/issues/${child.id}`, "PATCH", { parent_issue_id: null })).status).toBe(200);
        expect((await auth.request(auth.sourceOnly, `/api/issues/${child.id}`, "PATCH", { workspace_id: target })).status).toBe(404);
        expect(store.getIssue(child.id)?.workspaceId).toBe(source);
        expect((await auth.request(auth.both, `/api/issues/${child.id}`, "PATCH", { workspace_id: target })).status).toBe(200);
        expect(store.getIssue(child.id)).toMatchObject({ workspaceId: target, parentIssueId: null });
      });

      for (const prefix of ["/api/issues", "/api/multiremi/issues"]) {
        it(`${direction}: HTTP ${prefix} batch preflight rejects without runtime binding and leaves all rows unchanged`, async () => {
          const { source, target } = workspaces(reverse);
          const auth = await credentials(source, target);
          const parent = store.createIssue({ title: "Batch parent", workspaceId: source });
          store.createIssue({ title: "Batch child", workspaceId: source, parentIssueId: parent.id });
          const leaf = store.createIssue({ title: "Batch leaf first", workspaceId: source });
          const body = { issue_ids: [leaf.id, parent.id], updates: { workspace_id: target } };
          expect((await auth.request(auth.sourceOnly, `${prefix}/batch-update`, "POST", body)).status).toBe(404);
          for (const token of [auth.both, auth.root]) {
            const response = await auth.request(token, `${prefix}/batch-update`, "POST", body);
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({ code: "workspace_move_blocked", issue_ids: [parent.id] });
          }
          expect(store.getIssue(leaf.id)?.workspaceId).toBe(source);
          expect(store.getIssue(parent.id)?.workspaceId).toBe(source);
        });
      }

      it(`${direction}: HTTP moves refuse either dependency endpoint, including related, after target authorization`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        for (const type of ["blocked_by", "related"] as const) {
          const issue = store.createIssue({ title: "HTTP dependency", workspaceId: source });
          const other = store.createIssue({ title: "HTTP counterpart", workspaceId: source });
          const dependency = store.createIssueDependency(issue.id, { dependsOnIssueId: other.id, type });
          for (const [endpoint, peer] of [[issue, other], [other, issue]]) {
            for (const prefix of ["/api/issues", "/api/multiremi/issues"]) {
              expect((await auth.request(auth.sourceOnly, `${prefix}/${endpoint!.id}`, "PATCH", { workspace_id: target })).status).toBe(404);
              for (const token of [auth.both, auth.root]) {
                const response = await auth.request(token, `${prefix}/${endpoint!.id}`, "PATCH", { workspace_id: target });
                expect(response.status).toBe(409);
                expect((await response.json()).relations.dependencies).toEqual([{ id: dependency.id, key: peer!.key, type }]);
              }
            }
            expect(store.getIssue(endpoint!.id)?.workspaceId).toBe(source);
          }
        }
      });

      it(`${direction}: HTTP null and empty workspace inputs cannot bypass local target authorization`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const leaf = store.createIssue({ title: "Implicit local target", workspaceId: source });
        for (const workspace_id of [null, ""]) {
          expect((await auth.request(auth.sourceOnly, `/api/issues/${leaf.id}`, "PATCH", { workspace_id })).status).toBe(404);
          expect((await auth.request(auth.sourceOnly, "/api/issues/batch-update", "POST", {
            issue_ids: [leaf.id], updates: { workspace_id },
          })).status).toBe(404);
          expect(store.getIssue(leaf.id)?.workspaceId).toBe(source);
        }
      });

      it(`${direction}: W7 real CLI batch-update exits nonzero with workspace_move_blocked`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const parent = store.createIssue({ title: "CLI parent", workspaceId: source });
        store.createIssue({ title: "CLI child", workspaceId: source, parentIssueId: parent.id });
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: auth.app.fetch });
        try {
          const proc = Bun.spawn([process.execPath, "apps/remi/main.ts", "issue", "batch-update",
            "--data", JSON.stringify({ issue_ids: [parent.id], updates: { workspace_id: target } }),
            "--server", server.url.toString(), "--token", auth.both, "--output", "json"], {
            env: { PATH: process.env.PATH, HOME: process.env.TMPDIR ?? "/tmp" }, stdout: "pipe", stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          expect(code).not.toBe(0);
          expect(stdout + stderr).toContain("workspace_move_blocked");
          expect(store.getIssue(parent.id)?.workspaceId).toBe(source);
        } finally {
          server.stop(true);
        }
      });

      it(`${direction}: W8 HTTP refuses foreign parent creation, re-parenting and dependency insertion`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const issue = store.createIssue({ title: "Local issue", workspaceId: source });
        const foreign = store.createIssue({ title: "Foreign issue", workspaceId: target });
        for (const prefix of ["/api/issues", "/api/multiremi/issues"]) {
          for (const [path, method, body] of [
            [prefix, "POST", { title: "Invalid child", workspace_id: source, parent_issue_id: foreign.id }],
            [`${prefix}/${issue.id}`, "PATCH", { parent_issue_id: foreign.id }],
            [`${prefix}/${issue.id}/dependencies`, "POST", { depends_on_issue_id: foreign.id, type: "related" }],
          ] as const) {
            const response = await auth.request(auth.both, path, method, body);
            expect(response.status).toBe(400);
          }
        }
        expect(store.getIssue(issue.id)?.parentIssueId).toBeNull();
        expect(store.listIssueDependencies(issue.id)).toEqual([]);
      });

      it(`${direction}: R1 legacy foreign children, dependencies and human requests are absent over HTTP`, async () => {
        const { source, target, auth, parent, child, task } = await legacyTree(reverse);
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [source, parent.id]);
        const oldDecision = store.createIssueDecision(child.id, { kind: "question", title: "PRIVATE old decision" }, {
          type: "member", id: auth.sourceMember, taskId: null,
        });
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target, parent.id]);
        store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { message: "PRIVATE child question" } });
        const peer = store.createIssue({ title: "PRIVATE prerequisite", workspaceId: source });
        db.run(`INSERT INTO multiremi_issue_dependencies (id, workspace_id, issue_id, depends_on_issue_id, type, created_at)
          VALUES (?, ?, ?, ?, 'blocked_by', ?)`, [`legacy_${child.id}`, source, parent.id, peer.id, new Date().toISOString()]);
        const detail = await read(auth, auth.targetOnly, `/api/multiremi/issues/${parent.id}`);
        expect(detail.children).toEqual([]);
        expect(detail.issue.children).toEqual([]);
        expect(detail.issue.child_count).toBe(0);
        expect(detail.dependencies).toEqual([]);
        expect(detail.issue.waiting_on).toEqual([]);
        expect(detail.waiting_on.prerequisites).toEqual([]);
        for (const prefix of ["/api/issues", "/api/multiremi/issues"]) {
          const children = await read(auth, auth.targetOnly, `${prefix}/${parent.id}/children`);
          expect(children.issues).toEqual([]);
          const dependencies = await read(auth, auth.targetOnly, `${prefix}/${parent.id}/dependencies`);
          expect(dependencies.dependencies).toEqual([]);
          const multi = await read(auth, auth.targetOnly, `${prefix}/children?parent_ids=${parent.id}`);
          expect(JSON.stringify(multi)).not.toContain(child.title);
        }
        const decisions = await read(auth, auth.targetOnly, `/api/issues/${parent.id}/decisions`);
        expect(decisions.waiting_on_human).toEqual([]);
        expect(store.getIssueDecision(parent.id, oldDecision.id)).toBeNull();
        expect(store.countPendingIssueDecisions(parent.id)).toBe(0);
        expect((await read(auth, auth.targetOnly, `/api/issues/${parent.id}`)).pending_decision_count).toBe(0);
        expect((await shareBundle(auth, auth.sourceOnly, child.id)).parent_issue).toBeNull();
        expect((await shareBundle(auth, auth.targetOnly, parent.id)).children).toEqual([]);
        expect(store.listChildIssueProgress(target)).toEqual([]);
      });

      it(`${direction}: R2 closing a legacy foreign child emits no parent comments, rounds, inbox or workspace events`, async () => {
        const { target, auth, parent, child } = await legacyTree(reverse);
        const owner = store.createAgent({ name: "Parent owner", provider: "codex", workspaceId: target, ownerId: auth.targetMember });
        db.run("UPDATE multiremi_issues SET assignee_type = 'agent', assignee_id = ? WHERE id = ?", [owner.id, parent.id]);
        store.addIssueSubscriber(parent.id, auth.targetMember);
        const before = store.getIssue(parent.id);
        const comments = store.listIssueComments(parent.id);
        const inbox = store.listInboxItems(auth.targetMember, target);
        const events: string[] = [];
        const stop = store.onWorkspaceEvent((event) => { if (event.workspaceId === target) events.push(event.type); });
        try {
          const response = await auth.request(auth.sourceOnly, `/api/issues/${child.id}`, "PATCH", { status: "done" });
          expect(response.status, await response.clone().text()).toBe(200);
          expect(store.getIssue(child.id)?.status).toBe("done");
          expect(store.getIssue(parent.id)).toEqual(before);
          expect(store.listIssueComments(parent.id)).toEqual(comments);
          expect(store.listTasksForIssue(parent.id)).toEqual([]);
          expect(store.listInboxItems(auth.targetMember, target)).toEqual(inbox);
          expect(store.listIssueActivity(parent.id).filter((row) => row.type === "parent_status_derived")).toEqual([]);
          expect(events).toEqual([]);
        } finally { stop(); }
      });

      it(`${direction}: R3 a task decision with a legacy foreign parent escalates on its own source issue`, async () => {
        const { source, target, auth, parent, child, taskToken } = await legacyTree(reverse);
        const events: string[] = [];
        const stop = store.onWorkspaceEvent((event) => { if (event.workspaceId === target) events.push(event.type); });
        try {
          const response = await auth.request(taskToken, `/api/issues/${child.id}/decisions`, "POST", {
            kind: "question", title: "PRIVATE source decision", body: "PRIVATE body",
          });
          expect(response.status, await response.clone().text()).toBe(201);
          expect((await response.json()).decision).toMatchObject({ workspaceId: source, issueId: child.id, status: "escalated" });
          expect((await read(auth, auth.targetOnly, `/api/issues/${parent.id}/decisions`)).waiting_on_human).toEqual([]);
          expect(store.listTasksForIssue(parent.id)).toEqual([]);
          expect(store.listInboxItems(auth.targetMember, target)).toEqual([]);
          expect(events).toEqual([]);
        } finally { stop(); }
      });

      it(`${direction}: R4 legacy foreign dependencies neither reveal prerequisites nor automatically start another workspace`, async () => {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        for (const type of ["blocked_by", "blocks"] as const) {
          const prerequisite = store.createIssue({ title: "PRIVATE prerequisite", workspaceId: source });
          const owner = store.createAgent({ name: "Dependent owner", provider: "codex", workspaceId: target });
          const dependent = store.createIssue({ title: "Waiting dependent", workspaceId: target, status: "backlog",
            assigneeType: "agent", assigneeId: owner.id });
          const [a, b] = type === "blocks" ? [prerequisite.id, dependent.id] : [dependent.id, prerequisite.id];
          db.run(`INSERT INTO multiremi_issue_dependencies (id, workspace_id, issue_id, depends_on_issue_id, type, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`, [`legacy_${dependent.id}`, target, a, b, type, new Date().toISOString()]);
          expect(store.listUnmetPrerequisites(dependent.id)).toEqual([]);
          const detail = await read(auth, auth.targetOnly, `/api/multiremi/issues/${dependent.id}`);
          expect(detail.dependencies).toEqual([]);
          expect(detail.issue.waiting_on).toEqual([]);
          const events: string[] = [];
          const stop = store.onWorkspaceEvent((event) => { if (event.workspaceId === target) events.push(event.type); });
          try {
            const response = await auth.request(auth.sourceOnly, `/api/issues/${prerequisite.id}`, "PATCH", { status: "done" });
            expect(response.status).toBe(200);
            expect(store.getIssue(dependent.id)?.status).toBe("backlog");
            expect(store.listTasksForIssue(dependent.id)).toEqual([]);
            expect(events).toEqual([]);
          } finally { stop(); }
        }
      });

      it(`${direction}: R5 behavior change: legacy foreign children no longer prevent the parent from finishing`, async () => {
        const { auth, parent, child } = await legacyTree(reverse);
        const response = await auth.request(auth.targetOnly, `/api/issues/${parent.id}`, "PATCH", { status: "done" });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(store.getIssue(parent.id)?.status).toBe("done");
        expect(store.getIssue(child.id)?.status).toBe("todo");
        expect(store.hasChildIssues(parent.id)).toBe(false);
        expect(store.countOpenChildIssues(parent.id)).toBe(0);
      });

      it(`${direction}: R6 child detail, lists, inbox and share bundle omit the foreign parent's title, key and status`, async () => {
        const { source, auth, parent, child, agent } = await legacyTree(reverse);
        store.addIssueSubscriber(child.id, auth.sourceMember);
        store.createIssueComment(child.id, { authorType: "agent", authorId: agent.id,
          body: `Visible child update [@Reviewer](mention://member/${auth.sourceMember})` });
        expect(store.listInboxItems(auth.sourceMember, source)).toHaveLength(1);
        for (const path of [`/api/issues/${child.id}`, `/api/multiremi/issues/${child.id}`,
          `/api/issues?workspace_id=${source}`, `/api/multiremi/issues?workspace_id=${source}`,
          `/api/inbox?workspace_id=${source}`, `/api/multiremi/inbox?workspace_id=${source}`]) {
          const body = await read(auth, auth.sourceOnly, path);
          expect(JSON.stringify(body)).not.toContain(parent.title);
          expect(JSON.stringify(body)).not.toContain(parent.key);
          const text = JSON.stringify(body);
          expect(text).not.toMatch(/"parent_(title|key|status)":"/);
        }
        const bundle = await shareBundle(auth, auth.sourceOnly, child.id);
        expect(bundle.parent_issue).toBeNull();
        expect(bundle.issue.parent_issue_id).toBe(parent.id);
        expect(JSON.stringify(bundle)).not.toContain(parent.title);
        expect(JSON.stringify(bundle)).not.toContain(parent.key);
      });
    }
  });
}
