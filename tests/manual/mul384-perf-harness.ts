#!/usr/bin/env bun
/**
 * MUL-384 local end-to-end harness for the MUL-383 page-speed probe.
 *
 *   bun run tests/manual/mul384-perf-harness.ts
 *
 * Starts a real API (`startMultiremiServer`, in-memory SQLite) with seeded
 * issues, comments, sessions, inbox rows and one running task, then serves the
 * Next.js web app pointed at it, mints a local PAT, and runs
 * `frontend/scripts/perf/page-speed.ts` against the pair. Finally it greps the
 * produced artifacts for the token.
 *
 * This is the only place the probe is exercised end to end without production
 * credentials; nothing here reads or writes a remote host.
 *
 * Env:
 *   MUL384_API_PORT      API port (default 16380)
 *   MUL384_WEB_PORT      web port (default 3210)
 *   MUL384_OUT           report stem directory (default reports/performance)
 *   MUL384_ROUNDS        rounds per scenario (default 1)
 *   MUL384_NAME          report stem (default MUL-384-local-e2e)
 *   MUL384_KEEP          keep the servers up and print the command to re-run
 *   MUL384_SELECTORS     pass through to --selectors (auto|contract|legacy)
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";

/** First free port at or above `start`, so a stray dev server cannot poison a run. */
function findFreePort(start: number): number {
  for (let port = start; port < start + 50; port++) {
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
      probe.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`no free port in ${start}..${start + 50}`);
}

const API_PORT = Number(process.env.MUL384_API_PORT ?? findFreePort(16380));
const WEB_PORT = Number(process.env.MUL384_WEB_PORT ?? findFreePort(3210));
const OUT_DIR = process.env.MUL384_OUT ?? "reports/performance";
const NAME = process.env.MUL384_NAME ?? "MUL-384-local-e2e";
const ROUNDS = Number(process.env.MUL384_ROUNDS ?? 1);
const KEEP = process.env.MUL384_KEEP === "1";
const REPO_ROOT = resolve(import.meta.dir, "../..");
const TOKEN_PLACEHOLDER = "local-e2e-token-not-a-real-credential";

const database = new Database(":memory:");
const store = new MultiremiStore(database);
const workspace = store.ensureLocalWorkspace();
const slug = workspace.slug ?? "local";

const server = startMultiremiServer({
  store,
  port: API_PORT,
  hostname: "127.0.0.1",
  authToken: TOKEN_PLACEHOLDER,
  backgroundJobs: false,
  requestMetrics: { enabled: true, slowRequestMs: 0, summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 1024 },
});

const started: Array<{ kill: () => void }> = [];
function shutdown(): void {
  for (const child of started) child.kill();
  server.stop(true);
  database.close();
}

try {
  const base = `http://127.0.0.1:${API_PORT}`;

  // ── Seed a workspace that exercises every detail scenario ────────────────
  // Use the issue's *default* session, not a new one. The detail page opens the
  // default session and requests its timeline; comments written into a second
  // session render nowhere, which looks like a probe failure but is a fixture
  // bug (the timeline legitimately comes back empty).
  const session = (issueId: string) => store.getOrCreateDefaultIssueSession(issueId, store.getCurrentUser().id);

  const shortIssue = store.createIssue({
    id: "iss_local_short",
    title: "Local short issue",
    description: "A short issue for the local probe.",
    status: "in_progress",
    priority: "medium",
  });
  const shortSession = session(shortIssue.id);
  for (let i = 1; i <= 4; i++) {
    store.createIssueComment(shortIssue.id, {
      issueSessionId: shortSession.id,
      authorType: "member",
      authorId: store.getCurrentUser().id,
      body: `short comment ${i}`,
    });
  }

  const longIssue = store.createIssue({
    id: "iss_local_long",
    title: "Local long issue",
    description: "A long issue for the local probe.",
    status: "in_progress",
    priority: "medium",
  });
  const longSession = session(longIssue.id);
  for (let i = 1; i <= 60; i++) {
    store.createIssueComment(longIssue.id, {
      issueSessionId: longSession.id,
      authorType: "member",
      authorId: store.getCurrentUser().id,
      body: `long comment ${i}\n\nwith a second paragraph so the row has height`,
    });
  }
  // Production's long-issue failure mode: MUL-307's newest comment renders as a
  // single 3065px row inside an ~836px scroll root, so the legacy `contained`
  // rule could never be satisfied. Reproduce an oversized row here so the local
  // matrix exercises the tall-row rule instead of only finding it on 209.
  store.createIssueComment(longIssue.id, {
    issueSessionId: longSession.id,
    authorType: "member",
    authorId: store.getCurrentUser().id,
    body: Array.from({ length: 90 }, (_, i) => `## section ${i + 1}\n\n${"filler ".repeat(60)}`).join("\n\n"),
  });

  // A cancelled and an archived issue, so the local run covers the fixtures the
  // warm path must skip rather than only the ones it can click.
  const cancelledIssue = store.createIssue({
    id: "iss_local_cancelled",
    title: "Local cancelled issue",
    description: "Cancelled issues are not listed in the default issue list.",
    status: "cancelled",
    priority: "low",
  });
  session(cancelledIssue.id);
  const archivedIssue = store.createIssue({
    id: "iss_local_archived",
    title: "Local archived issue",
    description: "Archived issues are not listed in the default issue list.",
    status: "done",
    priority: "low",
  });
  session(archivedIssue.id);
  database.run("UPDATE multiremi_issues SET archived_at = ? WHERE id = ?", [new Date().toISOString(), archivedIssue.id]);

  const runningIssue = store.createIssue({
    id: "iss_local_running",
    title: "Local running issue",
    description: "An issue with an agent task currently running.",
    status: "in_progress",
    priority: "high",
  });
  const runningSession = session(runningIssue.id);
  store.createIssueComment(runningIssue.id, {
    issueSessionId: runningSession.id,
    authorType: "member",
    authorId: store.getCurrentUser().id,
    body: "trigger comment for the running agent",
  });
  const agent = store.createAgent({ name: "Local Perf Agent", provider: "codex" } as never);
  const runningTask = store.createTask({
    agentId: agent.id,
    issueId: runningIssue.id,
    issueSessionId: runningSession.id,
    prompt: "local fixture task",
  } as never);
  // Task status only moves through the dispatch flow, which a fixture does not
  // run; write the state the daemon would have written so the issue renders its
  // SessionAgentStreamRow (the `detail-running` terminal element).
  const startedAt = new Date().toISOString();
  database.run(
    "UPDATE multiremi_tasks SET status = 'running', dispatched_at = ?, started_at = ?, updated_at = ? WHERE id = ?",
    [startedAt, startedAt, startedAt, runningTask.id],
  );

  const deepLinkIssue = store.createIssue({
    id: "iss_local_deeplink",
    title: "Local deep-link issue",
    description: "An issue whose comment is the deep-link target.",
    status: "in_progress",
    priority: "low",
  });
  const deepLinkSession = session(deepLinkIssue.id);
  for (let i = 1; i <= 12; i++) {
    store.createIssueComment(deepLinkIssue.id, {
      issueSessionId: deepLinkSession.id,
      authorType: "member",
      authorId: store.getCurrentUser().id,
      body: `deep link comment ${i}`,
    });
  }

  // Inbox: page one must carry a notification whose details point at a comment.
  // Inbox rows are normally produced by the mention/subscription flows; the
  // fixture writes them straight into the in-memory database so the deep-link
  // scenario always has a page-one row with a `comment_id`.
  const deepLinkComments = store.listIssueComments(deepLinkIssue.id);
  const targetComment = deepLinkComments[1] ?? deepLinkComments[0];
  const me = store.getCurrentUser();
  // Inbox rows are scoped to the workspace *member* id, not the user id; the API
  // resolves one from the other, so seeding the wrong column hides the row.
  const member = store.listWorkspaceMembers(workspace.id).find((candidate) => candidate.userId === me.id)
    ?? store.listWorkspaceMembers(workspace.id)[0];
  if (!member) throw new Error("local workspace has no member to seed an inbox row for");
  const now = new Date().toISOString();
  const insertInbox = (
    id: string,
    type: string,
    title: string,
    details: Record<string, unknown>,
    createdAt: string = now,
    issueId: string = deepLinkIssue.id,
  ): void => {
    database.run(
      `INSERT INTO multiremi_inbox_items (
        id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity,
        actor_type, actor_id, type, title, body, details, read, archived, created_at
      ) VALUES (?, ?, ?, ?, 'member', ?, 'info', 'member', ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id,
        workspace.id,
        issueId,
        member.id,
        member.id,
        me.id,
        type,
        title,
        "points at a comment inside a session",
        JSON.stringify(details),
        createdAt,
      ],
    );
  };
  const inboxItemId = "inb_local_deeplink";
  insertInbox(inboxItemId, "comment_created", "Local deep-link notification", {
    comment_id: targetComment?.id ?? null,
    issue_session_id: deepLinkSession.id,
  });
  // A second, autopilot-shaped row proves the probe filters those out.
  insertInbox("inb_local_autopilot", "autopilot_run_report", "Autopilot run", {
    comment_id: targetComment?.id ?? null,
    issue_session_id: deepLinkSession.id,
  });
  // Rows with no comment/session cannot be deep-link targets. They sit ahead of
  // the eligible row (a later timestamp) so the probe has to reject them, and
  // they hang off a *different* issue: `?issue=` resolves to that issue's newest
  // notification, so sharing the deeplink issue would shadow it and the deep link
  // would never find its target comment.
  for (let i = 0; i < 3; i++) {
    insertInbox(
      `inb_local_bare_${i}`,
      "comment_created",
      `Bare notification ${i}`,
      {},
      new Date(Date.now() + 60_000).toISOString(),
      cancelledIssue.id,
    );
  }
  const inboxItem = { id: inboxItemId };

  process.stdout.write(
    `seeded: short=${shortIssue.key} long=${longIssue.key} running=${runningIssue.key} deeplink=${deepLinkIssue.key} inbox=${inboxItem?.id ?? "none"}\n`,
  );

  // ── Start the web app against this API ──────────────────────────────────
  // The web server logs continuously; a `pipe` that nobody drains blocks the
  // process once the pipe buffer fills (which looks exactly like a hung page).
  // Write it to a file instead, so the child never blocks on its own output.
  // The probe drives the web origin from a browser, so `next dev` has to see its
  // own dev requests as same-origin. Next 16 blocks cross-origin `/_next/*`
  // fetches unless the host is listed in `allowedDevOrigins`, and the rejected
  // responses never hydrate the app: the page stays an empty shell with zero API
  // calls, which reads exactly like a probe bug. `localhost` is the origin Next
  // serves by default, so use it for the web side; the API stays on 127.0.0.1.
  const webBase = `http://localhost:${WEB_PORT}`;
  const webLogPath = join(REPO_ROOT, "reports", "performance", `.mul384-web-${WEB_PORT}.log`);
  mkdirSync(join(REPO_ROOT, "reports", "performance"), { recursive: true });
  const webLog = (await import("node:fs")).openSync(webLogPath, "a");
  // `next dev` keeps a lock per app directory, so a leftover instance for this
  // checkout makes every new spawn exit immediately ("Another next dev server
  // is already running"). A leftover cannot serve this run either: it was
  // started against a different API origin, which is why the loop reuses a port
  // rather than a process. Clear the strays belonging to *this* checkout only.
  killStaleNextDev(join(REPO_ROOT, "frontend/apps/web"));
  const reuse = process.env.MUL384_REUSE_WEB === "1" || (await isUp(`${webBase}/login`));
  const web = reuse
    ? null
    : Bun.spawn({
        cmd: ["bun", "run", "--filter", "@multiremi/web", "dev"],
        cwd: join(REPO_ROOT, "frontend"),
        env: {
          ...process.env,
          FRONTEND_PORT: String(WEB_PORT),
          REMOTE_API_URL: base,
          MULTIREMI_ALLOW_EMAIL_CODE_LOGIN: "1",
        },
        stdout: webLog,
        stderr: webLog,
      });
  if (web) started.push({ kill: () => web.kill() });
  process.stdout.write(`web: ${reuse ? "reusing the server already on this port" : `log ${webLogPath}`}\n`);

  // Fail fast when the dev server dies (a compile error, a port squatter):
  // waiting the full timeout on a dead process says nothing useful.
  await Promise.race([
    waitForHttp(`${webBase}/login`, 180_000),
    ...(web
      ? [
          web.exited.then((code) => {
            if (code !== 0) throw new Error(`web dev server exited with ${code}; see ${webLogPath}`);
          }),
        ]
      : []),
  ]);

  // Mint a PAT straight from the in-memory store: it is the same token type the
  // web app accepts in `localStorage.multimira_token`, and it avoids depending
  // on the email-code flow's feature flag in the API process.
  const minted = await store.createAccessToken({
    name: "MUL-384 local perf harness",
    type: "pat",
    purpose: "personal",
    workspaceId: workspace.id,
    userId: store.getCurrentUser().id,
    expiresInDays: 1,
  });
  const token = minted.token;
  if (!token) throw new Error("store did not return a token");
  const probeCheck = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!probeCheck.ok) throw new Error(`minted token rejected by /api/me: ${probeCheck.status}`);
  process.stdout.write(`minted local PAT; /api/me -> ${probeCheck.status}\n`);

  const reportDir = join(REPO_ROOT, OUT_DIR);
  mkdirSync(reportDir, { recursive: true });

  process.stdout.write(`running probe against ${webBase}\n`);
  const probeBudgetMs = Number(process.env.MUL384_PROBE_TIMEOUT_MS ?? 900_000);
  const probe = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(REPO_ROOT, "frontend/scripts/perf/page-speed.ts"),
      "--base-url",
      webBase,
      "--rounds",
      String(ROUNDS),
      "--window",
      "offpeak",
      // The local web server is `next dev`: it compiles each route on first
      // request, which alone exceeds the 20 s round budget. Production runs a
      // built image, so its baselines are collected without this flag.
      "--warmup",
      "--name",
      NAME,
      "--out",
      reportDir,
      "--issue-short",
      shortIssue.id,
      "--issue-long",
      longIssue.id,
      "--issue-running",
      runningIssue.id,
      ...(process.env.MUL384_ONLY ? ["--only", process.env.MUL384_ONLY] : []),
      ...(process.env.MUL384_SELECTORS ? ["--selectors", process.env.MUL384_SELECTORS] : []),
      ...(process.env.MUL384_INBOX_MODE === "unpinned" ? [] : ["--inbox-item", inboxItem?.id ?? ""]),
    ],
    cwd: REPO_ROOT,
    env: { ...process.env, MULTIREMI_QA_WEB_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Stream both pipes: the probe writes a line per round, and buffering until
  // exit would hide a stall behind an apparently silent run.
  const pump = async (stream: ReadableStream<Uint8Array> | undefined, sink: (text: string) => void): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink(decoder.decode(value, { stream: true }));
    }
  };
  let probeErrText = "";
  const probeTimer = setTimeout(() => {
    process.stderr.write(`probe exceeded ${probeBudgetMs}ms; killing it\n`);
    probe.kill();
  }, probeBudgetMs);
  const [probeExit] = await Promise.all([
    probe.exited,
    pump(probe.stdout, (text) => process.stdout.write(text)),
    pump(probe.stderr, (text) => {
      probeErrText += text;
      process.stderr.write(text);
    }),
  ]);
  clearTimeout(probeTimer);
  if (probeExit !== 0) throw new Error(`probe exited with ${probeExit}${probeErrText.trim() ? `: ${probeErrText.trim().split("\n").slice(-3).join(" | ")}` : ""}`);

  // ── Token leak check ────────────────────────────────────────────────────
  const artifacts = readdirSync(reportDir).filter((file) => file.startsWith(NAME));
  const leaks: string[] = [];
  for (const file of artifacts) {
    const body = readFileSync(join(reportDir, file), "utf8");
    if (body.includes(token)) leaks.push(`${file}: token`);
    if (body.includes("multimira_token")) leaks.push(`${file}: token key`);
    if (body.includes(TOKEN_PLACEHOLDER)) leaks.push(`${file}: fixture token`);
  }
  process.stdout.write(`\nartifacts: ${artifacts.join(", ")}\n`);
  if (leaks.length > 0) {
    process.stderr.write(`TOKEN LEAK: ${leaks.join("; ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`token grep: 0 hits across ${artifacts.length} artifact(s)\n`);
  }

  if (KEEP) {
    process.stdout.write(
      `\nservers are up: web=${webBase} api=${base}\nre-run the probe with:\n  MULTIREMI_QA_WEB_TOKEN=<token> bun run frontend/scripts/perf/page-speed.ts --base-url ${webBase} --rounds 1 --name ${NAME}-rerun --issue-short ${shortIssue.id} --issue-long ${longIssue.id} --issue-running ${runningIssue.id} --inbox-item ${inboxItem?.id ?? ""}\n`,
    );
    await new Promise(() => {});
  }
} finally {
  if (!KEEP) shutdown();
}

/**
 * Kills the `next dev` instance that holds this checkout's dev lock.
 *
 * Scoped by lock file on purpose: the Issue workspace is shared with other
 * agents, so a dev server rooted in another checkout is none of our business.
 * The lock records the server PID, which is the only reliable handle — the
 * `next-server` process does not carry the directory in its command line.
 */
function killStaleNextDev(appDir: string): void {
  const lockPath = join(appDir, ".next", "dev", "lock");
  let pids: number[] = [];
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (typeof lock.pid === "number") pids.push(lock.pid);
  } catch {
    // No lock: nothing to clear.
  }
  // The lock PID is `next-server`; its parents are `next dev`, the `sh -c`
  // wrapper and `bun run --filter`. Walk up only while the ancestor is one of
  // those. An orphaned dev server is reparented to `systemd --user`: an
  // unbounded walk SIGKILLs the user manager, which restarts every user unit,
  // the multiremi daemon and all its tasks included.
  const own = new Set([process.pid, ...parentPids(process.pid)]);
  for (const pid of pids) {
    for (const candidate of [pid, ...parentPids(pid)]) {
      if (own.has(candidate) || !isCheckoutDevServer(candidate, appDir)) break;
      try {
        process.kill(candidate, "SIGKILL");
        process.stdout.write(`killed stale dev server pid=${candidate}\n`);
      } catch {
        // Already gone, or not ours to kill.
      }
    }
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Next rewrites it when it starts.
  }
}

/**
 * True for a `next-server` / `next dev` / `sh -c next dev` / `bun run --filter
 * @multiremi/web` process whose working directory is this checkout's frontend.
 * `next-server` carries no path in its command line, so the directory check
 * goes through `/proc/<pid>/cwd`.
 */
function isCheckoutDevServer(pid: number, appDir: string): boolean {
  if (pid <= 1) return false;
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    const frontendDir = resolve(appDir, "../..");
    const inCheckout = cwd === appDir || cwd === frontendDir;
    return inCheckout && /next-server|next dev|@multiremi\/web/.test(cmd);
  } catch {
    return false;
  }
}

function parentPids(pid: number): number[] {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const ppid = Number(fields[1]);
    return Number.isFinite(ppid) && ppid > 1 ? [ppid, ...parentPids(ppid)] : [];
  } catch {
    return [];
  }
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}
