/**
 * The `body_html` idle backfill (MUL-439).
 *
 * The acceptance points from the issue description are the start gate — "只在
 * B1 的列存在时启动，不存在就不启动" — and the re-render rule, "`render_version`
 * 过期的行也重新渲染". Both are exercised against the real store on SQLite,
 * with the table created the way B1 will create it.
 *
 * The task is driven by `runBatch()` rather than the timer, so the tests do not
 * depend on the pause between batches; `start()` is exercised separately for
 * the gate itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  BodyHtmlBackfillTask,
  BODY_HTML_BACKFILL_BATCH_SIZE,
  conversationLogBodyHtmlColumnsExist,
} from "@multiremi/render/body-html-backfill.js";
import { RENDER_VERSION } from "@multiremi/render/markdown.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

/**
 * The B1 table, narrowed to the columns this task touches. B1's migration is
 * its own; the point here is that the task works against the shape it declares.
 */
function createConversationLog(withBodyHtmlColumns = true): void {
  const bodyHtml = withBodyHtmlColumns
    ? "body_html TEXT, render_version TEXT,"
    : "";
  db!.exec(`
    CREATE TABLE multiremi_conversation_log (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body_md TEXT,
      ${bodyHtml}
      PRIMARY KEY(session_id, seq)
    )
  `);
}

function insertRow(
  sessionId: string,
  seq: number,
  bodyMd: string,
  bodyHtml: string | null = null,
  renderVersion: string | null = null,
): void {
  db!.run(
    `INSERT INTO multiremi_conversation_log (session_id, seq, body_md, body_html, render_version)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, seq, bodyMd, bodyHtml, renderVersion],
  );
}

function rowAt(sessionId: string, seq: number): { body_html: string | null; render_version: string | null } {
  return db!
    .query(
      "SELECT body_html, render_version FROM multiremi_conversation_log WHERE session_id = ? AND seq = ?",
    )
    .get(sessionId, seq) as { body_html: string | null; render_version: string | null };
}

function countPending(): number {
  return (
    db!.query(
      "SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE body_html IS NULL OR render_version IS NULL OR render_version <> ?",
    ).get(RENDER_VERSION) as { n: number }
  ).n;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

describe("body_html backfill: start gate", () => {
  test("does not start when the table is absent", () => {
    const store = createStore();
    const task = new BodyHtmlBackfillTask({ store });
    expect(task.start()).toBe(false);
    expect(task.started).toBe(false);
    expect(task.columnsPresent).toBe(false);
    task.stop();
  });

  test("does not start when the table exists without body_html/render_version", () => {
    const store = createStore();
    createConversationLog(false);
    const task = new BodyHtmlBackfillTask({ store });
    expect(conversationLogBodyHtmlColumnsExist(store)).toBe(false);
    expect(task.start()).toBe(false);
    expect(task.started).toBe(false);
    task.stop();
  });

  test("starts when both columns are present", () => {
    const store = createStore();
    createConversationLog();
    const task = new BodyHtmlBackfillTask({ store, intervalMs: 60_000 });
    expect(conversationLogBodyHtmlColumnsExist(store)).toBe(true);
    expect(task.start()).toBe(true);
    expect(task.started).toBe(true);
    task.stop();
    expect(task.started).toBe(false);
  });

  test("probe picks up a table that appears after the first attempt", () => {
    // The API process can boot before B1's migration runs. `probe()` is what
    // lets a caller retry without restarting.
    const store = createStore();
    const task = new BodyHtmlBackfillTask({ store });
    expect(task.start()).toBe(false);
    createConversationLog();
    expect(task.probe()).toBe(true);
    expect(task.start()).toBe(true);
    task.stop();
  });

  test("a table with no rows is not an error", async () => {
    const store = createStore();
    createConversationLog();
    const task = new BodyHtmlBackfillTask({ store });
    expect(await task.runBatch()).toBe(0);
    task.stop();
  });
});

describe("body_html backfill: rendering", () => {
  test("fills rows whose body_html is NULL", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "# Title\n\ntext");
    insertRow("ises_1", 1, "**bold**");
    const task = new BodyHtmlBackfillTask({ store });

    expect(await task.runBatch()).toBe(2);
    expect(rowAt("ises_1", 0).body_html).toContain("<h1>Title</h1>");
    expect(rowAt("ises_1", 1).body_html).toContain("<strong>bold</strong>");
    expect(rowAt("ises_1", 1).render_version).toBe(RENDER_VERSION);
    task.stop();
  });

  test("re-renders rows whose render_version is stale", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "current", "<p>current</p>", RENDER_VERSION);
    insertRow("ises_1", 1, "stale", "<p>from an older pipeline</p>", "md-0000000000000000");

    const task = new BodyHtmlBackfillTask({ store });
    // Only the stale row is a candidate; the current one must be left alone.
    expect(await task.runBatch()).toBe(1);
    expect(rowAt("ises_1", 0).body_html).toBe("<p>current</p>");
    expect(rowAt("ises_1", 1).body_html).toContain("stale");
    expect(rowAt("ises_1", 1).render_version).toBe(RENDER_VERSION);
    task.stop();
  });

  test("treats a NULL render_version as stale, even with HTML present", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "text", "<p>orphan</p>", null);
    const task = new BodyHtmlBackfillTask({ store });
    expect(await task.runBatch()).toBe(1);
    expect(rowAt("ises_1", 0).body_html).toContain("text");
    expect(rowAt("ises_1", 0).render_version).toBe(RENDER_VERSION);
    task.stop();
  });

  test("is idempotent: a drained table produces no further work", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "one");
    const task = new BodyHtmlBackfillTask({ store });
    expect(await task.runBatch()).toBe(1);
    const after = rowAt("ises_1", 0);
    expect(await task.runBatch()).toBe(0);
    // The second pass must not have re-written the row.
    expect(rowAt("ises_1", 0)).toEqual(after);
    task.stop();
  });

  test("an empty body_md renders, rather than being skipped or throwing", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "");
    const task = new BodyHtmlBackfillTask({ store });
    expect(await task.runBatch()).toBe(1);
    expect(rowAt("ises_1", 0).render_version).toBe(RENDER_VERSION);
    task.stop();
  });

  test("one failing row does not stop the batch and stays a candidate", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "poison");
    insertRow("ises_1", 1, "good");

    const task = new BodyHtmlBackfillTask({
      store,
      render: (markdown) => {
        if (markdown === "poison") throw new Error("boom");
        return { html: `<p>${markdown}</p>`, render_version: RENDER_VERSION };
      },
    });

    // `runBatch` reports rows it actually wrote, so the poisoned row is not
    // counted; it stays NULL and remains a candidate.
    expect(await task.runBatch()).toBe(1);
    expect(rowAt("ises_1", 0).body_html).toBeNull();
    expect(rowAt("ises_1", 1).body_html).toBe("<p>good</p>");

    // The next pass picks the poisoned row back up and writes nothing else.
    expect(await task.runBatch()).toBe(0);
    expect(rowAt("ises_1", 0).body_html).toBeNull();
    expect(rowAt("ises_1", 1).body_html).toBe("<p>good</p>");
    task.stop();
  });

  test("processes at most one batch per call and in a stable order", async () => {
    const store = createStore();
    createConversationLog();
    const total = BODY_HTML_BACKFILL_BATCH_SIZE + 10;
    for (let seq = 0; seq < total; seq++) insertRow("ises_1", seq, `row ${seq}`);

    const task = new BodyHtmlBackfillTask({ store, render: (md) => ({ html: `<p>${md}</p>`, render_version: RENDER_VERSION }) });
    expect(await task.runBatch()).toBe(BODY_HTML_BACKFILL_BATCH_SIZE);
    expect(await task.runBatch()).toBe(10);
    expect(await task.runBatch()).toBe(0);

    const remaining = db!
      .query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE body_html IS NULL")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    task.stop();
  });

  test("renders across sessions, not just the first", async () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_a", 0, "alpha");
    insertRow("ises_b", 0, "beta");
    insertRow("chat_c", 0, "gamma");
    const task = new BodyHtmlBackfillTask({ store });
    expect(await task.runBatch()).toBe(3);
    expect(rowAt("ises_a", 0).body_html).toContain("alpha");
    expect(rowAt("ises_b", 0).body_html).toContain("beta");
    expect(rowAt("chat_c", 0).body_html).toContain("gamma");
    task.stop();
  });
});

describe("body_html backfill: the loop", () => {
  test("start() drains the table through the timer and stop() halts it", async () => {
    // The batches above are driven by hand; this is the one that goes through
    // the timer, so the wiring in `start()`/`tick()` is covered too.
    const store = createStore();
    createConversationLog();
    for (let seq = 0; seq < 3; seq++) insertRow("ises_1", seq, `row ${seq}`);

    const task = new BodyHtmlBackfillTask({ store, intervalMs: 0 });
    expect(task.start()).toBe(true);
    await waitFor(() => countPending() === 0, 2_000);
    task.stop();

    expect(rowAt("ises_1", 2).render_version).toBe(RENDER_VERSION);
    const settled = rowAt("ises_1", 2).body_html;
    // After stop(), more rows appear but nothing renders them.
    insertRow("ises_1", 9, "after stop");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowAt("ises_1", 2).body_html).toBe(settled);
    expect(rowAt("ises_1", 9).body_html).toBeNull();
  });
});

describe("body_html backfill: store API guardrails", () => {
  test("the candidate query returns nothing before the table exists", () => {
    // The task's own gate covers this, but the store method has to be safe on
    // its own: it is reachable from anywhere the store is.
    const store = createStore();
    expect(store.conversationLogRenderColumns()).toBeNull();
    expect(store.listConversationLogRowsNeedingBodyHtml(RENDER_VERSION, 10)).toEqual([]);
  });

  test("the guarded update only touches the addressed row", () => {
    const store = createStore();
    createConversationLog();
    insertRow("ises_1", 0, "a");
    insertRow("ises_2", 0, "b");
    expect(store.setConversationLogBodyHtml("ises_1", 0, "<p>a</p>", RENDER_VERSION)).toBe(1);
    expect(rowAt("ises_1", 0).body_html).toBe("<p>a</p>");
    expect(rowAt("ises_2", 0).body_html).toBeNull();
    // A row that is not there updates nothing rather than throwing.
    expect(store.setConversationLogBodyHtml("ises_missing", 0, "x", RENDER_VERSION)).toBe(0);
  });
});
