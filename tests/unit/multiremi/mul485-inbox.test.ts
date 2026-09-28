import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const plan = readFileSync(new URL("../../fixtures/multiremi/mul404-plan.md", import.meta.url), "utf8").trimEnd();

async function verifyPlanRoundTrip(store: MultiremiStore): Promise<void> {
  const issue = store.createIssue({ title: "MUL-485 fixture", workspaceId: "local" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const comment = store.createIssueComment(issue.id, { issueSessionId: session.id, body: plan });
  const entry = store.getConversationLogEntryById(comment.id)!;
  const event: MultiremiSessionEvent = {
    id: entry.id, sessionId: session.id, seq: entry.seq, kind: entry.kind,
    authorType: "member", authorId: "local", body: entry.body_md,
    taskId: null, sourceCommentId: comment.id, metadata: entry.metadata,
    createdAt: entry.created_at,
  };
  const projection = buildSessionProjection({
    sessionId: session.id, targetAgentId: "agt_reader", events: [event], cursorSeq: 0,
    providerSessionId: null, tokenBudget: 20_000,
  });
  const [header, toc, folded] = projection.jsonl.split("\n").map((line) => JSON.parse(line));
  expect(header.type).toBe("session_projection");
  expect(toc.entries[0]).toMatchObject({ seq: entry.seq, id: entry.id, chars: plan.length, folded: true });
  expect(folded.body_folded).toBe(true);
  expect(folded.body_summary).toContain(plan.slice(0, 600));
  expect(folded.body_summary).toContain("## 0. 结论");
  expect(folded.body_omitted_chars).toBe(plan.length - 600);
  expect(folded.expand).toBe(`remi session log get ${session.id} ${entry.seq}`);
  expect(folded.body).toBeUndefined();

  const app = createMultiremiApp({ store });
  for (const locator of [`seq=${entry.seq}`, `id=${entry.id}`]) {
    const response = await app.request(`/api/sessions/${session.id}/log/entry?${locator}`);
    expect(response.status).toBe(200);
    const complete = await response.json();
    expect(complete.body_md).toBe(plan);
    expect(complete.body_md.length).toBe(plan.length);
    expect(complete.metadata).toEqual(entry.metadata);
    expect(complete).toHaveProperty("delivered");
  }
  for (const query of ["", "?seq=-1", "?seq=1.5", `?seq=${entry.seq}&id=${entry.id}`]) {
    expect((await app.request(`/api/sessions/${session.id}/log/entry${query}`)).status).toBe(400);
  }
  expect((await app.request(`/api/sessions/${session.id}/log/entry?id=missing`)).status).toBe(404);
  expect((await app.request(`/api/sessions/ises_other/log/entry?seq=${entry.seq}`)).status).not.toBe(200);
}

afterEach(resetMultiremiTestEnv);

describe("MUL-485 SQLite", () => {
  it("folds the complete published plan and expands it by seq or id", async () => {
    expect(plan.length).toBe(40_447);
    await verifyPlanRoundTrip(createStore());
  });

  it("orders the inbox by priority then seq and leaves old daemon JSONL readable", () => {
    const events = [
      makeEvent(1, "lifecycle", "FYI", "system", { envelope: envelope("lifecycle", 4) }),
      makeEvent(2, "task_completed", "finished", "system"),
      makeEvent(3, "task_failed", "blocked", "system"),
      makeEvent(4, "message", "@agt_reader decide", "member"),
      makeEvent(5, "message", "@agt_reader another decision", "member"),
    ];
    const projection = buildSessionProjection({ sessionId: "ises_priority", targetAgentId: "agt_reader",
      events, cursorSeq: 0, providerSessionId: null, tokenBudget: 10_000 });
    const toc = JSON.parse(projection.jsonl.split("\n")[1]!);
    expect(toc.entries.map((entry: { seq: number; priority: number }) => [entry.seq, entry.priority]))
      .toEqual([[4, 1], [5, 1], [3, 2], [2, 3], [1, 4]]);
    const task = { id: "tsk_inbox", workspaceId: "local", issueId: "iss_inbox", chatSessionId: null,
      prompt: "Read inbox", issueSession: { id: "ises_priority", title: "Inbox" },
      sessionProjection: projection, repos: [], projectResources: [], project: null,
      agent: { id: "agt_reader", name: "Reader", provider: "codex", skills: [], instructions: "", customEnv: {} } };
    const prompt = buildTaskPrompt(task as never);
    expect(prompt).toContain("## Inbox");
    expect(prompt.indexOf("## Inbox")).toBeLessThan(prompt.indexOf("## Current Session Context"));
    const old = buildTaskPrompt({ ...task, id: "tsk_old", prompt: "Read history", sessionProjection: {
      ...projection, jsonl: projection.jsonl.split("\n").filter((line) => !line.includes('"type":"inbox_toc"')).join("\n"),
    } } as never);
    expect(old).toContain("## Current Session Context");
    expect(old).not.toContain("## Inbox");
  });
});

function makeEvent(seq: number, kind: string, body: string, authorType: string, metadata: Record<string, unknown> = {}): MultiremiSessionEvent {
  return { id: `sevt_${seq}`, sessionId: "ises_priority", seq, kind, body, authorType,
    authorId: authorType === "member" ? "local" : null, taskId: null, sourceCommentId: null,
    metadata, createdAt: "2026-09-29T00:00:00.000Z" };
}

function envelope(kind: "lifecycle", priority: number) {
  return { kind, wake: "inbox_only", priority, to: { role: "agent", agentId: "agt_reader", issueSessionId: "ises_priority" }, source: {} };
}

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const pgDbName = `mul485_test_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
describe.skipIf(!pgAdminUrl)("MUL-485 PostgreSQL", () => {
  let admin: Bun.SQL;
  let database: PostgresSyncDatabase;
  let store: MultiremiStore;

  beforeAll(async () => {
    const url = new URL(pgAdminUrl!);
    if (!(["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
      throw new Error("MULTIREMI_TEST_POSTGRES_URL must point to a local dedicated test server");
    }
    try {
      admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
      await admin`SELECT 1`;
      await admin.unsafe(`CREATE DATABASE ${pgDbName}`);
      url.pathname = `/${pgDbName}`;
      database = new PostgresSyncDatabase(url.toString());
      store = new MultiremiStore(database);
      store.ensureLocalWorkspace();
    } catch {
      throw new Error("Configured local test PostgreSQL is unavailable or cannot create a dedicated database");
    }
  });

  afterAll(async () => {
    database?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${pgDbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("folds and expands the identical plan fixture on real PostgreSQL", async () => {
    await verifyPlanRoundTrip(store);
  });
});
