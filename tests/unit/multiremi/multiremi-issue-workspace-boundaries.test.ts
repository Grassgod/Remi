import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
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
        db = new Database(":memory:");
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
        expect(childError.relations).toEqual({ parent: null, children: [], dependencies: [], hidden: 2 });
        const parentError = moveError(() => store.updateIssue(parent.id, { workspaceId: source }));
        expect(parentError.relations).toEqual({ parent: null, children: [], dependencies: [], hidden: 1 });
        expect(store.getIssue(child.id)?.workspaceId).toBe(source);
      });
    }
  });
}
