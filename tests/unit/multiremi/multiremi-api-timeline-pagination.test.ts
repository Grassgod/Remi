import { afterEach, describe, expect, it } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

let databases: Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

function createStore(): { store: MultiremiStore; db: Database } {
  const db = new Database(":memory:");
  databases.push(db);
  return { store: new MultiremiStore(db), db };
}

const AUTH_TOKEN = "timeline-pagination-test-token";
const AUTH_HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

function setCommentTime(db: Database, id: string, createdAt: string): void {
  db.run(
    "UPDATE multiremi_issue_comments SET created_at = ?, updated_at = ? WHERE id = ?",
    [createdAt, createdAt, id],
  );
}

describe("issue timeline reverse pagination", () => {
  it("returns the latest page first and walks to the oldest page without duplicates", async () => {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const issue = store.createIssue({ title: "Paged session", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comments = Array.from({ length: 5 }, (_, index) => {
      const comment = store.createIssueComment(issue.id, {
        issueSessionId: session.id,
        body: `comment-${index}`,
      });
      setCommentTime(db, comment.id, `2026-09-05T00:00:0${index}.000Z`);
      return comment;
    });

    const firstResponse = await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${session.id}&limit=2`,
      { headers: AUTH_HEADERS },
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.entries.map((entry: { id: string }) => entry.id)).toEqual([
      comments[3]!.id,
      comments[4]!.id,
    ]);
    expect(first.has_more).toBe(true);
    expect(first.has_more_before).toBe(true);
    expect(first.next_cursor).toBeTruthy();
    expect(first.issue_session_id).toBe(session.id);

    const second = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${session.id}&limit=2&before=${encodeURIComponent(first.next_cursor)}`,
      { headers: AUTH_HEADERS },
    )).json();
    const third = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${session.id}&limit=2&before=${encodeURIComponent(second.next_cursor)}`,
      { headers: AUTH_HEADERS },
    )).json();
    expect(second.entries.map((entry: { id: string }) => entry.id)).toEqual([
      comments[1]!.id,
      comments[2]!.id,
    ]);
    expect(second.has_more).toBe(true);
    expect(third.entries.map((entry: { id: string }) => entry.id)).toEqual([comments[0]!.id]);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();

    const allIds = [...third.entries, ...second.entries, ...first.entries]
      .map((entry: { id: string }) => entry.id);
    expect(allIds).toEqual(comments.map((comment) => comment.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("uses id as the tie breaker when entries share created_at and handles exact page division", async () => {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const issue = store.createIssue({ title: "Cursor ties", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comments = Array.from({ length: 4 }, (_, index) => store.createIssueComment(issue.id, {
      issueSessionId: session.id,
      body: `tie-${index}`,
    }));
    for (const comment of comments) setCommentTime(db, comment.id, "2026-09-05T01:00:00.000Z");
    const ascendingIds = comments.map((comment) => comment.id).sort();

    const first = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${session.id}&limit=2`,
      { headers: AUTH_HEADERS },
    )).json();
    const second = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${session.id}&limit=2&before=${encodeURIComponent(first.next_cursor)}`,
      { headers: AUTH_HEADERS },
    )).json();
    expect([...second.entries, ...first.entries].map((entry: { id: string }) => entry.id)).toEqual(ascendingIds);
    expect(first.has_more).toBe(true);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();
  });

  it("returns an empty terminal page for an empty session timeline", async () => {
    const { store } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const issue = store.createIssue({ title: "Empty page", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);

    const response = await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${session.id}&limit=40`,
      { headers: AUTH_HEADERS },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [],
      has_more: false,
      has_more_before: false,
      next_cursor: null,
      issue_session_id: session.id,
    });
  });

  it("merges comments with issue activity only for the aggregate timeline", () => {
    const { store, db } = createStore();
    const issue = store.createIssue({ title: "Aggregate page", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: "comment" });
    store.appendIssueActivity(issue.id, { actorType: "system", type: "custom_event", body: "activity" });
    setCommentTime(db, comment.id, "2026-09-05T02:00:00.000Z");
    db.run(
      "UPDATE multiremi_issue_activity SET created_at = '2026-09-05T02:00:01.000Z' WHERE issue_id = ? AND type = 'custom_event'",
      [issue.id],
    );

    const aggregate = store.listIssueTimelinePage(issue.id, { limit: 100 });
    const scoped = store.listIssueTimelinePage(issue.id, { issueSessionId: session.id, limit: 2 });
    expect(aggregate.entries.some((entry) => entry.id === comment.id && entry.type === "comment")).toBe(true);
    expect(aggregate.entries.some((entry) => entry.action === "custom_event" && entry.type === "activity")).toBe(true);
    expect(scoped.entries.map((entry) => entry.type)).toEqual(["comment"]);
  });

  it("resolves @default to the default, then the first session, then aggregate", async () => {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const issue = store.createIssue({ title: "Default primer", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const sibling = store.createIssueSession(issue.id, { title: "Sibling" });

    const withDefault = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=%40default&limit=40`,
      { headers: AUTH_HEADERS },
    )).json();
    expect(withDefault.issue_session_id).toBe(main.id);

    db.run("UPDATE multiremi_issue_sessions SET is_default = 0 WHERE issue_id = ?", [issue.id]);
    const expectedFirst = store.listIssueSessions(issue.id)[0]!.id;
    const withoutDefault = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=%40default&limit=40`,
      { headers: AUTH_HEADERS },
    )).json();
    expect(withoutDefault.issue_session_id).toBe(expectedFirst);
    expect([main.id, sibling.id]).toContain(expectedFirst);

    db.run("DELETE FROM multiremi_issue_sessions WHERE issue_id = ?", [issue.id]);
    const withoutSession = await (await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=%40default&limit=40`,
      { headers: AUTH_HEADERS },
    )).json();
    expect(withoutSession.issue_session_id).toBeNull();
    expect(withoutSession.entries.some((entry: { type: string }) => entry.type === "activity")).toBe(true);
  });

  it("rejects invalid limits and cursors", async () => {
    const { store } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const issue = store.createIssue({ title: "Invalid page", workspaceId: "local" });

    for (const limit of ["0", "101", "1.5", "nope"]) {
      const response = await app.request(`/api/issues/${issue.id}/timeline?limit=${limit}`, { headers: AUTH_HEADERS });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid limit" });
    }
    const invalidCursor = await app.request(`/api/issues/${issue.id}/timeline?before=not-a-cursor`, { headers: AUTH_HEADERS });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toEqual({ error: "invalid cursor" });
  });
});

describe("issue timeline hydration query count", () => {
  it("stays constant as the page fills", () => {
    const db = new Database(":memory:");
    databases.push(db);
    let queryCount = 0;
    const countingDb: SqlDatabase = {
      query(sql) {
        queryCount += 1;
        return db.query(sql);
      },
      prepare: (sql) => db.prepare(sql),
      run(sql, ...params) {
        const bindings = (
          params.length === 1 && Array.isArray(params[0]) ? params[0] : params
        ) as SQLQueryBindings[];
        return db.run(sql, bindings);
      },
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
      close: () => db.close(),
    };
    const store = new MultiremiStore(countingDb);
    const issue = store.createIssue({ title: "Constant SQL", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    for (let index = 0; index < 20; index += 1) {
      store.createIssueComment(issue.id, { issueSessionId: session.id, body: `row-${index}` });
    }

    queryCount = 0;
    expect(store.listIssueTimelinePage(issue.id, { issueSessionId: session.id, limit: 1 }).entries).toHaveLength(1);
    const oneEntryQueries = queryCount;
    queryCount = 0;
    expect(store.listIssueTimelinePage(issue.id, { issueSessionId: session.id, limit: 20 }).entries).toHaveLength(20);
    const fullPageQueries = queryCount;

    expect(oneEntryQueries).toBe(5);
    expect(fullPageQueries).toBe(oneEntryQueries);
  });
});
