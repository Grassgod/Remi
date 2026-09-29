import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { IssueWorkspaceMoveError } from "@multiremi/store/repos/issues-repo.js";

const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(backend === "PostgreSQL" && !pgUrl)(`MUL-476 workspace boundaries (${backend})`, () => {
    let db: Database | PostgresSyncDatabase;
    let store: MultiremiStore;
    let admin: Bun.SQL | undefined;
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
    });

    afterAll(async () => {
      db?.close();
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        await admin.end();
      }
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
      const app = createMultiremiApp({ store, authToken: "mul476-test-root", shareSecret: "mul476-test-share" });
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

    for (const reverse of [false, true]) {
      const direction = reverse ? "B -> A" : "A -> B";

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
        expect(childError.relations).toEqual({ parent: null, children: [], dependencies: [], tasks: [], hidden: 2 });
        const parentError = moveError(() => store.updateIssue(parent.id, { workspaceId: source }));
        expect(parentError.relations).toEqual({ parent: null, children: [], dependencies: [], tasks: [], hidden: 1 });
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
