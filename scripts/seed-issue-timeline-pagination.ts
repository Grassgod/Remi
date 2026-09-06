#!/usr/bin/env bun

// Must stay first: macOS uses this hook to replace the system SQLite build.
import "@shared/db/sqlite-custom.js";

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { getDb, setDbPath } from "@shared/db/index.js";

interface Args {
  dbPath: string;
  port: number;
  serve: boolean;
}

function parseArgs(argv: string[]): Args {
  let dbPath = ".tmp/mul-249/remi.db";
  let port = 6120;
  let serve = false;
  for (const arg of argv) {
    if (arg === "--serve") {
      serve = true;
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!dbPath.trim()) throw new Error("--db must not be empty");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return { dbPath: resolve(dbPath), port, serve };
}

function seedIssue(
  store: MultiremiStore,
  input: { id: string; title: string; count: number; start: string },
) {
  const issue = store.getIssue(input.id) ?? store.createIssue({
    id: input.id,
    workspaceId: "local",
    title: input.title,
    description: `MUL-249 QA fixture with ${input.count} chronological comments.`,
    status: "in_progress",
    priority: "medium",
  });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const existing = store.listIssueTimeline(issue.id, {
    ascending: true,
    issueSessionId: session.id,
  });
  const baseTime = Date.parse(input.start);
  for (let index = existing.length; index < input.count; index += 1) {
    const comment = store.createIssueComment(issue.id, {
      issueSessionId: session.id,
      authorType: "member",
      authorId: "mem_local_local",
      body: `MUL-249 timeline entry ${String(index + 1).padStart(3, "0")} of ${input.count}`,
    });
    const createdAt = new Date(baseTime + index * 60_000).toISOString();
    getDb().run(
      "UPDATE multiremi_issue_comments SET created_at = ?, updated_at = ? WHERE id = ?",
      [createdAt, createdAt, comment.id],
    );
  }
  return {
    issue_id: issue.id,
    key: issue.key,
    session_id: session.id,
    timeline_entries: store.listIssueTimeline(issue.id, {
      ascending: true,
      issueSessionId: session.id,
    }).length,
    path: `/local/issues/${issue.id}`,
  };
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(dirname(args.dbPath), { recursive: true });
setDbPath(args.dbPath);
const store = new MultiremiStore();
store.ensureLocalWorkspace();

const fixtures = {
  database: args.dbPath,
  long_issue: seedIssue(store, {
    id: "iss_mul249_long",
    title: "MUL-249 QA long timeline (96 entries)",
    count: 96,
    start: "2026-09-01T00:00:00.000Z",
  }),
  short_issue: seedIssue(store, {
    id: "iss_mul249_short",
    title: "MUL-249 QA short timeline (6 entries)",
    count: 6,
    start: "2026-09-02T00:00:00.000Z",
  }),
};

console.log(JSON.stringify(fixtures, null, 2));

if (args.serve) {
  const server = startMultiremiServer({
    store,
    port: args.port,
    hostname: "127.0.0.1",
    authToken: "",
    backgroundJobs: false,
  });
  console.log(`MUL-249 QA API listening on http://127.0.0.1:${server.port ?? args.port}`);
  await new Promise<void>((resolveStop) => {
    const stop = () => {
      server.stop(true);
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
