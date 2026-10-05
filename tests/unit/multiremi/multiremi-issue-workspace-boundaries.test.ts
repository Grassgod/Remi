import { issueMessagesPath, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
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
          const row = store.createWorkspaceMember({ workspaceId, userId: user.id, name: user.name, email: user.email, role: "member" });
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
      db.run("UPDATE multiremi_issue_sessions SET workspace_id=? WHERE issue_id=?",[target,parent.id]);
      db.run("UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id IN (SELECT id FROM multiremi_issue_sessions WHERE issue_id=?)",[target,parent.id]);
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
      mutateExecutionFixture(db, "UPDATE multiremi_turn_execution_records SET status = 'completed' WHERE id = ?", [task.id]);
      store.updateIssue(issueId, { status: "done" });
      return task;
    }

    for (const reverse of [false, true]) {
      const direction = reverse ? "B -> A" : "A -> B";

      async function moveFixture(assigneeType: "agent" | "member" | "squad" = "agent", withProject = true) {
        const { source, target } = workspaces(reverse);
        const auth = await credentials(source, target);
        const agent = store.createAgent({ name: "Original owner", provider: "codex", workspaceId: source });
        const squad = store.createSquad({ name: "Original squad", leaderId: agent.id, workspaceId: source });
        const owner = assigneeType === "agent" ? agent : assigneeType === "squad" ? squad : store.getWorkspaceMember(auth.sourceMember)!;
        const project = store.createProject({ title: "Original project", workspaceId: source });
        const labels = ["Original label 1", "Original label 2"].map(name => store.createLabel({ name, color: "#123456", workspaceId: source }));
        const created = store.createIssue({ title: "Movable leaf", workspaceId: source,
          assigneeType, assigneeId: owner.id, ...(withProject ? { projectId: project.id } : {}) });
        for (const label of labels) store.attachLabelToIssue(created.id, label.id);
        const issue = store.getIssue(created.id)!;
        return { source, target, auth, owner, assigneeType, project, labels, issue };
      }

      function cleared(issueId: string) {
        return store.listIssueActivity(issueId).filter(row => row.type === "workspace_move_cleared");
      }

      function moveLog(issueId: string) {
        const session = store.getOrCreateDefaultIssueSession(issueId);
        return store.listConversationLogEntries(session.id).filter(row => row.kind === "message"
          && row.metadata.type === "workspace_move_cleared");
      }

      for (const assigneeType of ["agent", "member", "squad"] as const) {
        it(`${direction}: MUL-480 clears inherited ${assigneeType}, project and each label with name-only audit`, async () => {
          const f = await moveFixture(assigneeType);
          // Same names in the target must never be used to remap inherited IDs.
          store.createAgent({ name: f.owner.name, provider: "codex", workspaceId: f.target });
          store.createProject({ title: f.project.title, workspaceId: f.target });
          for (const label of f.labels) store.createLabel({ name: label.name, color: "#654321", workspaceId: f.target });
          const next = store.updateIssue(f.issue.id, { workspace_id: f.target, actorType: "member", actorId: f.auth.targetMember });
          expect(next).toMatchObject({ workspaceId: f.target, assigneeType: null, assigneeId: null, projectId: null });
          expect(store.listLabelsForIssue(f.issue.id)).toEqual([]);
          const rows = cleared(f.issue.id);
          expect(rows).toHaveLength(4);
          expect(rows.map(row => row.data)).toEqual([
            { field: "assignee", name: f.owner.name, assignee_type: assigneeType },
            { field: "project", name: f.project.title },
            ...f.labels.map(label => ({ field: "label", name: label.name })),
          ]);
          for (const row of rows) {
            expect(row.body).toBe((row.data as { name: string }).name);
            expect(row).toMatchObject({ actorType: "member", actorId: f.auth.targetMember });
          }
          const log = moveLog(f.issue.id);
          expect(log).toHaveLength(4);
          expect(log.map(row => row.metadata)).toEqual(rows.map(row => ({ type: "workspace_move_cleared", execution_scope:"",
            ...(row.data as { field: string; name: string; assignee_type?: string }) })));
          for (const row of log) {
            expect(row).toMatchObject({ kind: "message", sender_type: "platform", task_id: null, reply_to_id: null });
            for (const privateValue of [f.owner.id, f.project.id, f.source, ...f.labels.map(label => label.id), "#123456"])
              expect(JSON.stringify(row.metadata)).not.toContain(privateValue);
          }
          // System audit rows are display-only: no task, including a pending turn.
          expect(store.listTasksForIssue(f.issue.id)).toEqual([]);
          store.updateIssue(f.issue.id, { workspaceId: f.target });
          expect(moveLog(f.issue.id)).toEqual(log);
        });
      }

      it(`${direction}: MUL-480 system log escapes names as text, including links and mentions`, async () => {
        const { source, target } = workspaces(reverse);
        const names = ["**Bold** _italic_ `code` $math$", "[x](mention://agent/fake)", '[@ id="fake" label="x"]',
          "https://example.test/path", "a@example.test <b>x</b>", "line one\n# heading\n- item"];
        const issue = store.createIssue({ title: "Literal names", workspaceId: source });
        for (const name of names) store.attachLabelToIssue(issue.id, store.createLabel({ name, color: "#123456", workspaceId: source }).id);
        store.updateIssue(issue.id, { workspaceId: target });
        const log = moveLog(issue.id);
        expect(log).toHaveLength(names.length);
        expect(log.map(row => row.metadata)).toEqual(expect.arrayContaining(names.map(name => ({ type: "workspace_move_cleared", execution_scope:"", field: "label", name }))));
        for (const row of log) {
          expect(row.body_md).not.toContain("mention://");
          expect(row.body_md).not.toContain("https://");
          expect(row.body_html).not.toMatch(/<(?:a|strong|em|code|b|h[1-6]|ul|li)\b/);
        }
        expect(log.find(row => row.metadata.name === names[0])!.body_md).toContain("&#42;&#42;Bold&#42;&#42;");
        expect(log.find(row => row.metadata.name === names[0])!.body_html).toContain(names[0]!);
        expect(log.find(row => row.metadata.name === names[1])!.body_md).toContain("&#91;x&#93;&#40;mention&#58;&#47;&#47;agent&#47;fake&#41;");
        expect(store.listTasksForIssue(issue.id)).toEqual([]);
      });

      it(`${direction}: MUL-480 empty moves and repeated moves add no system log rows`, () => {
        const { source, target } = workspaces(reverse);
        const issue = store.createIssue({ title: "No inherited values", workspaceId: source });
        const session = store.getOrCreateDefaultIssueSession(issue.id);
        const before = store.listConversationLogEntries(session.id);
        store.updateIssue(issue.id, { workspaceId: target });
        store.updateIssue(issue.id, { workspaceId: target });
        expect(store.listConversationLogEntries(session.id)).toEqual(before);
        expect(store.listTasksForIssue(issue.id)).toEqual([]);
      });

      it(`${direction}: MUL-480 reproduces owner and label leftovers without a project`, async () => {
        const f = await moveFixture("agent", false);
        const next = store.updateIssue(f.issue.id, { workspaceId: f.target });
        expect(next.assigneeId).toBeNull();
        expect(store.listLabelsForIssue(f.issue.id)).toEqual([]);
        expect(cleared(f.issue.id)).toHaveLength(3);
        expect(cleared(f.issue.id).every(row => row.actorType === "system" && row.actorId === null)).toBe(true);
      });

      it(`${direction}: MUL-480 preserves explicit target owners and project in both input spellings`, async () => {
        for (const assigneeType of ["agent", "member", "squad"] as const) for (const camel of [false, true]) {
          const f = await moveFixture();
          const agent = store.createAgent({ name: "Target owner", provider: "codex", workspaceId: f.target });
          const owner = assigneeType === "agent" ? agent : assigneeType === "member" ? store.getWorkspaceMember(f.auth.targetMember)!
            : store.createSquad({ name: "Target squad", leaderId: agent.id, workspaceId: f.target });
          const project = store.createProject({ title: "Target project", workspaceId: f.target });
          const next = store.updateIssue(f.issue.id, camel
            ? { workspaceId: f.target, assigneeType, assigneeId: owner.id, projectId: project.id }
            : { workspace_id: f.target, assignee_type: assigneeType, assignee_id: owner.id, project_id: project.id });
          expect(next).toMatchObject({ workspaceId: f.target, assigneeType, assigneeId: owner.id, projectId: project.id });
          expect(cleared(f.issue.id).map(row => (row.data as { field: string }).field)).toEqual(["label", "label"]);
        }
      });

      it(`${direction}: MUL-480 rejects explicit source values and leaves all fields and audits untouched`, async () => {
        for (const field of ["agent", "member", "squad", "project"] as const) {
          const f = await moveFixture(field === "project" ? "agent" : field);
          const before = store.listIssueActivity(f.issue.id);
          expect(() => store.updateIssue(f.issue.id, { workspace_id: f.target,
            ...(field === "project" ? { project_id: f.project.id } : { assignee_type: field, assignee_id: f.owner.id }) })).toThrow();
          expect(store.getIssue(f.issue.id)).toEqual(f.issue);
          expect(store.listLabelsForIssue(f.issue.id).map(row => row.id)).toEqual(f.labels.map(row => row.id));
          expect(store.listIssueActivity(f.issue.id)).toEqual(before);
        }
      });

      it(`${direction}: MUL-480 empty moves and same-workspace updates do not write clearing audits`, async () => {
        const { source, target } = workspaces(reverse);
        const empty = store.createIssue({ title: "Empty", workspaceId: source });
        store.updateIssue(empty.id, { workspaceId: target });
        expect(cleared(empty.id)).toEqual([]);
        const f = await moveFixture();
        const next = store.updateIssue(f.issue.id, { title: "Edited", workspaceId: f.source });
        expect(next).toMatchObject({ assigneeId: f.owner.id, projectId: f.project.id });
        expect(store.listLabelsForIssue(f.issue.id).map(row => row.id)).toEqual(f.labels.map(row => row.id));
        expect(cleared(f.issue.id)).toEqual([]);
      });

      it(`${direction}: MUL-480 batch moves clear inherited fields too`, async () => {
        const f = await moveFixture("squad");
        store.batchUpdateIssues({ issue_ids: [f.issue.id], updates: { workspace_id: f.target } });
        expect(store.getIssue(f.issue.id)).toMatchObject({ workspaceId: f.target, assigneeType: null, assigneeId: null, projectId: null });
        expect(store.listLabelsForIssue(f.issue.id)).toEqual([]);
        expect(cleared(f.issue.id)).toHaveLength(4);
      });

      it(`${direction}: MUL-480 explicit null fields are ordinary clearing, not move clearing`, async () => {
        const f = await moveFixture("member");
        const next = store.updateIssue(f.issue.id, { workspaceId: f.target, assigneeType: null, assigneeId: null, projectId: null });
        expect(next).toMatchObject({ workspaceId: f.target, assigneeType: null, assigneeId: null, projectId: null });
        expect(cleared(f.issue.id).map(row => (row.data as { field: string }).field)).toEqual(["label", "label"]);
      });

      it(`${direction}: MUL-480 does not map the same user to a different target member record`, async () => {
        const f = await moveFixture("member", false);
        const sourceMember = store.listWorkspaceMembers(f.source).find(row => row.userId === f.auth.bothUser)!;
        const targetMember = store.listWorkspaceMembers(f.target).find(row => row.userId === f.auth.bothUser)!;
        expect(sourceMember.id).not.toBe(targetMember.id);
        db.run("UPDATE multiremi_issues SET assignee_id = ? WHERE id = ?", [sourceMember.id, f.issue.id]);
        expect(store.updateIssue(f.issue.id, { workspaceId: f.target }).assigneeId).toBeNull();
        expect(cleared(f.issue.id).find(row => (row.data as { field: string }).field === "assignee")?.data)
          .toEqual({ field: "assignee", name: sourceMember.name, assignee_type: "member" });
      });

      it(`${direction}: MUL-480 retains inherited target references and removes only source label links`, async () => {
        const f = await moveFixture();
        const owner = store.createAgent({ name: "Target inherited owner", provider: "codex", workspaceId: f.target });
        const project = store.createProject({ title: "Target inherited project", workspaceId: f.target });
        const label = store.createLabel({ name: "Target inherited label", color: "#abcdef", workspaceId: f.target });
        db.run("UPDATE multiremi_issues SET assignee_id = ?, project_id = ? WHERE id = ?", [owner.id, project.id, f.issue.id]);
        db.run("INSERT INTO multiremi_issue_to_labels (issue_id, label_id) VALUES (?, ?)", [f.issue.id, label.id]);
        const next = store.updateIssue(f.issue.id, { workspaceId: f.target });
        expect(next).toMatchObject({ assigneeType: "agent", assigneeId: owner.id, projectId: project.id });
        expect(store.listLabelsForIssue(f.issue.id).map(row => row.id)).toEqual([label.id]);
        expect(cleared(f.issue.id)).toHaveLength(2);
        for (const original of f.labels) expect(store.getLabel(original.id)).toEqual(original);
      });

      it(`${direction}: MUL-480 clears missing inherited references without using IDs as names`, async () => {
        const { source, target } = workspaces(reverse);
        const issue = store.createIssue({ title: "Dangling references", workspaceId: source });
        db.run("UPDATE multiremi_issues SET assignee_type = 'agent', assignee_id = ?, project_id = ? WHERE id = ?",
          ["agt_missing_original", "prj_missing_original", issue.id]);
        const next = store.updateIssue(issue.id, { workspaceId: target });
        expect(next).toMatchObject({ workspaceId: target, assigneeType: null, assigneeId: null, projectId: null });
        expect(cleared(issue.id).map(row => row.data)).toEqual([
          { field: "assignee", name: "?", assignee_type: "agent" }, { field: "project", name: "?" },
        ]);
      });

      it(`${direction}: MUL-480 rollback after cleanup restores fields, labels and audit without emitting success`, async () => {
        const f = await moveFixture();
        const before = store.listIssueActivity(f.issue.id);
        const session = store.getOrCreateDefaultIssueSession(f.issue.id);
        const logBefore = store.listConversationLogEntries(session.id);
        const commentsBefore = store.listIssueComments(f.issue.id);
        const sessionEventsBefore = store.listSessionEvents(session.id);
        const events: string[] = [];
        const stop = store.onWorkspaceEvent(event => events.push(event.type));
        const run = db.run.bind(db);
        let injected = false;
        const fault = spyOn(db, "run").mockImplementation((...args: Parameters<Database["run"]>) => {
          const [sql] = args;
          if (sql.includes("UPDATE multiremi_issue_workspaces")) {
            injected = true;
            expect(store.getIssue(f.issue.id)?.workspaceId).toBe(f.target);
            expect(store.listLabelsForIssue(f.issue.id)).toEqual([]);
            expect(cleared(f.issue.id)).toHaveLength(4);
            expect(moveLog(f.issue.id)).toHaveLength(4);
            expect(events).toEqual([]);
            throw new Error("MUL-480 injected failure after clearing");
          }
          return run(...args);
        });
        try {
          expect(() => store.updateIssue(f.issue.id, { workspaceId: f.target })).toThrow("MUL-480 injected failure after clearing");
        } finally { fault.mockRestore(); stop(); }
        expect(injected).toBe(true);
        expect(store.getIssue(f.issue.id)).toEqual(f.issue);
        expect(store.listLabelsForIssue(f.issue.id).map(row => row.id)).toEqual(f.labels.map(row => row.id));
        expect(store.listIssueActivity(f.issue.id)).toEqual(before);
        expect(store.listConversationLogEntries(session.id)).toEqual(logBefore);
        expect(store.listIssueComments(f.issue.id)).toEqual(commentsBefore);
        expect(store.listSessionEvents(session.id)).toEqual(sessionEventsBefore);
        expect(events).toEqual([]);
      });

      it(`${direction}: MUL-480 label and clearing events publish committed target state only`, async () => {
        const f = await moveFixture();
        const events: Array<{ type: string; workspaceId: string; payload: unknown }> = [];
        const stop = store.onWorkspaceEvent(event => {
          expect(db.inTransaction).toBe(false);
          expect(store.getIssue(f.issue.id)?.workspaceId).toBe(f.target);
          events.push(event);
        });
        try { store.updateIssue(f.issue.id, { workspaceId: f.target }); } finally { stop(); }
        const labelsEvent = events.find(row => row.type === "issue_labels:changed");
        expect(labelsEvent).toMatchObject({ workspaceId: f.target, payload: { issue_id: f.issue.id, labels: [] } });
        expect(events.find(row => row.type === "issue:deleted"))
          .toMatchObject({ workspaceId: f.source, payload: { issue_id: f.issue.id } });
        expect(events.filter(row => row.type === "issue:updated")).toHaveLength(1);
        expect(events.find(row => row.type === "issue:updated"))
          .toMatchObject({ workspaceId: f.target, payload: { issue: { assignee_type: null, assignee_id: null, project_id: null, labels: [] } } });
        const auditEvents = events.filter(row => row.type === "activity:created"
          && (row.payload as { entry: { action: string } }).entry.action === "workspace_move_cleared");
        expect(auditEvents).toHaveLength(4);
        for (const row of auditEvents) {
          expect(row.workspaceId).toBe(f.target);
          const text = JSON.stringify(row.payload);
          for (const privateValue of [f.owner.id, f.project.id, f.source, ...f.labels.map(label => label.id), "#123456"]) expect(text).not.toContain(privateValue);
        }
        const commentEvents = events.filter(row => row.type === "comment:created");
        expect(commentEvents).toHaveLength(4);
        for (const row of commentEvents) {
          expect(row.workspaceId).toBe(f.target);
          const comment = (row.payload as { comment: { id: string } }).comment;
          expect(moveLog(f.issue.id).some(entry => entry.id === comment.id)).toBe(true);
        }
      });

      it(`${direction}: MUL-480 authenticated target HTTP reads clear fields and expose name-only new activities`, async () => {
        for (const [prefix, method] of [["/api/issues", "PATCH"], ["/api/issues", "PUT"], ["/api/multiremi/issues", "PATCH"]] as const) {
          const f = await moveFixture("member");
          const events: string[] = [];
          const stop = store.onWorkspaceEvent(event => events.push(event.type));
          const moved = await f.auth.request(f.auth.both, `${prefix}/${f.issue.id}`, method, { workspace_id: f.target });
          stop();
          expect(moved.status, await moved.clone().text()).toBe(200);
          expect(events.filter(type => type === "issue:updated")).toHaveLength(1);
          const detail = await read(f.auth, f.auth.targetOnly, `/api/issues/${f.issue.id}`);
          expect(detail).toMatchObject({ assignee_type: null, assignee_id: null, project_id: null, labels: [] });
          expect(await read(f.auth, f.auth.targetOnly, `/api/issues/${f.issue.id}/labels`)).toEqual({ labels: [] });
          const timeline = await read(f.auth, f.auth.targetOnly, `/api/issues/${f.issue.id}/timeline`);
          const session = store.getOrCreateDefaultIssueSession(f.issue.id);
          // Default Session ownership stays in the source (reported separately).
          // The moving actor can read its v2 Log through membership in both workspaces.
          const log = await read(f.auth, f.auth.both, `/api/sessions/${session.id}/log`);
          const systemRows = log.entries.filter((row: { kind: string; metadata: { type?: string } }) =>
            row.kind === "message" && row.metadata.type === "workspace_move_cleared");
          expect(systemRows).toHaveLength(4);
          expect(systemRows.map((row: { metadata: unknown }) => row.metadata)).toEqual(moveLog(f.issue.id).map(row => ({...row.metadata,attachments:[],reactions:[]})));
          const newActivities = timeline.filter((row: { action?: string }) => row.action === "workspace_move_cleared");
          expect(newActivities).toHaveLength(4);
          for (const privateValue of [f.owner.id, f.project.id, f.source, ...f.labels.map(label => label.id), "#123456",
            store.getWorkspaceMember(f.auth.sourceMember)!.email!]) {
            expect(JSON.stringify(detail)).not.toContain(privateValue);
            expect(JSON.stringify(newActivities)).not.toContain(privateValue);
            expect(JSON.stringify(systemRows.map((row: { metadata: unknown }) => row.metadata))).not.toContain(privateValue);
          }
          // Scope decision cmt_ve0mfxj4iab4: existing audit rows remain intact.
          expect(timeline.find((row: { action?: string }) => row.action === "issue_created").details.projectId).toBe(f.project.id);
          for (const path of [`/api/issues/${f.issue.id}`, `/api/issues/${f.issue.id}/labels`, `/api/issues/${f.issue.id}/timeline`]) {
            expect((await f.auth.request(f.auth.sourceOnly, path, "GET")).status).toBe(404);
          }
        }
      });

      it(`${direction}: MUL-480 HTTP batch moves multiple leaves and audits each independently`, async () => {
        for (const prefix of ["/api/issues", "/api/multiremi/issues"]) {
          const f = await moveFixture("squad");
          const second = store.createIssue({ title: "Second leaf", workspaceId: f.source, assigneeType: "member", assigneeId: f.auth.sourceMember });
          const response = await f.auth.request(f.auth.both, `${prefix}/batch-update`, "POST", {
            issue_ids: [f.issue.id, second.id], updates: { workspace_id: f.target },
          });
          expect(response.status, await response.clone().text()).toBe(200);
          expect(store.getIssue(f.issue.id)).toMatchObject({ workspaceId: f.target, assigneeId: null, projectId: null, labels: [] });
          expect(store.getIssue(second.id)).toMatchObject({ workspaceId: f.target, assigneeId: null });
          expect(cleared(f.issue.id)).toHaveLength(4);
          expect(cleared(second.id)).toHaveLength(1);
        }
      });

      it(`${direction}: MUL-480 subscriber investigation: source member stays subscribed but gets no target comment`, async () => {
        const f = await moveFixture("member");
        store.addIssueSubscriber(f.issue.id, f.auth.sourceMember);
        const before = store.listInboxItems(f.auth.sourceMember);
        store.updateIssue(f.issue.id, { workspaceId: f.target });
        const otherTargetMember = store.listWorkspaceMembers(f.target).find(row => row.userId === f.auth.bothUser)!;
        store.addIssueSubscriber(f.issue.id, otherTargetMember.id);
        const targetBefore = store.listInboxItems(otherTargetMember.id).length;
        const session = store.createIssueSession(f.issue.id, { title: "Target notification probe" });
        store.createIssueComment(f.issue.id, { body: "Target-only new content", authorType: "member", authorId: f.auth.targetMember, issueSessionId: session.id });
        expect(store.listIssueSubscribers(f.issue.id).some(row => row.userId === f.auth.sourceMember)).toBe(true);
        expect(store.listInboxItems(f.auth.sourceMember)).toEqual(before);
        expect(store.listInboxItems(otherTargetMember.id)).toHaveLength(targetBefore + 1);
        // The subscriber list is not filtered on move; this is an identified
        // residual source member ID, reported separately without changing it.
        const subscribers = await read(f.auth, f.auth.targetOnly, `/api/issues/${f.issue.id}/subscribers`);
        expect(subscribers.some((row: { user_id: string }) => row.user_id === f.auth.sourceMember)).toBe(true);
      });

      it(`${direction}: moved Issue status notifications use the target orphan inbox without creating or moving a Session`, async () => {
        const f = await moveFixture("member");
        const oldSession = store.getOrCreateDefaultIssueSession(f.issue.id);
        store.addIssueSubscriber(f.issue.id, f.auth.sourceMember);
        const sourceInbox = store.listInboxItems(f.auth.sourceMember);
        store.updateIssue(f.issue.id, { workspaceId: f.target });
        store.addIssueSubscriber(f.issue.id, f.auth.targetMember);
        const prerequisite = store.createIssue({ title: "Target prerequisite", workspaceId: f.target, status: "todo" });
        store.createIssueDependency(f.issue.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
        store.updateIssue(f.issue.id, { status: "backlog" });
        const sourceLog = store.listConversationLogEntries(oldSession.id);
        const targetBefore = store.listInboxItems(f.auth.targetMember).length;

        expect(() => store.updateIssue(prerequisite.id, { status: "done" })).not.toThrow();
        const notifications = store.listInboxItems(f.auth.targetMember);
        expect(notifications).toHaveLength(targetBefore + 1);
        const notification = notifications.find(item => item.type === "dependency_satisfied")!;
        expect(store.getMessage(notification.id)).toMatchObject({ session_id: `auto_orphan_inbox_${f.target}`,
          message_kind: "status", to_member_id: f.auth.targetMember });
        expect(store.getIssueSession(oldSession.id)?.workspaceId).toBe(f.source);
        expect(store.listIssueSessions(f.issue.id, true).map(session => session.id)).toEqual([oldSession.id]);
        expect(store.listConversationLogEntries(oldSession.id)).toEqual(sourceLog);
        expect(store.listInboxItems(f.auth.sourceMember)).toEqual(sourceInbox);
      });

      it(`${direction}: MUL-480 real CLI batch-update moves a leaf with inherited fields`, async () => {
        const f = await moveFixture();
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.auth.app.fetch });
        try {
          const proc = Bun.spawn([process.execPath, "apps/remi/main.ts", "issue", "batch-update",
            "--data", JSON.stringify({ issue_ids: [f.issue.id], updates: { workspace_id: f.target } }),
            "--server", server.url.toString(), "--token", f.auth.both, "--output", "json"], {
            env: { PATH: process.env.PATH, HOME: process.env.TMPDIR ?? "/tmp" }, stdout: "pipe", stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          expect(code, stdout + stderr).toBe(0);
          expect(store.getIssue(f.issue.id)).toMatchObject({ workspaceId: f.target, assigneeType: null, assigneeId: null, projectId: null, labels: [] });
          expect(cleared(f.issue.id)).toHaveLength(4);
        } finally { server.stop(true); }
      });

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
        mutateExecutionFixture(db, "UPDATE multiremi_turn_execution_records SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), task.id]);
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
        db.run("UPDATE multiremi_issue_sessions SET workspace_id=? WHERE issue_id=?",[source,parent.id]);
        db.run("UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id IN (SELECT id FROM multiremi_issue_sessions WHERE issue_id=?)",[source,parent.id]);
        const oldDecision = store.createIssueDecision(child.id, { kind: "question", title: "PRIVATE old decision" }, {
          type: "member", id: auth.sourceMember, taskId: null,
        });
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target, parent.id]);
      db.run("UPDATE multiremi_issue_sessions SET workspace_id=? WHERE issue_id=?",[target,parent.id]);
      db.run("UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id IN (SELECT id FROM multiremi_issue_sessions WHERE issue_id=?)",[target,parent.id]);
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
        const decisions = await read(auth, auth.targetOnly, issueMessagesPath(store, parent.id) + "?message_kind=decision");
        expect(decisions.messages).toEqual([]);
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
        const { source, target, auth, parent, child, agent, task } = await legacyTree(reverse);
        const events: string[] = [];
        const stop = store.onWorkspaceEvent((event) => { if (event.workspaceId === target) events.push(event.type); });
        try {
          const decision = store.createIssueDecision(child.id, {
            kind: "question", title: "PRIVATE source decision", body: "PRIVATE body",
          }, { type: "agent", id: agent.id, taskId: task.id });
          expect(decision).toMatchObject({ workspaceId: source, issueId: child.id, status: "escalated" });
          expect((await read(auth, auth.targetOnly, issueMessagesPath(store, parent.id) + "?message_kind=decision")).messages).toEqual([]);
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
          `/api/inbox?workspace_id=${source}`, "/api/inbox"+`?workspace_id=${source}`]) {
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
