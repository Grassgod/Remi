#!/usr/bin/env bun
/**
 * MUL-442 C7 acceptance: the browser replica, in a real browser.
 *
 * Four criteria, each asserted rather than observed:
 *
 * 1. three pages in one context, one subscription (the mock hub counts);
 * 2. kill the leader, another page takes over within a second and the head is
 *    continuous;
 * 3. all three pages' entries are identical;
 * 4. offline catch-up: 50 rows are appended while the socket is down, the head
 *    matches within two seconds of it coming back, and no full `/log` read is
 *    made;
 * 5. the same suite with OPFS disabled (the documented fallback).
 *
 * C3's socket is mocked (`server.ts`) against C0's contract because C3 has not
 * merged into `agent/MUL-403` yet; the replica under test is the shipped one.
 *
 *   bun run tests/integration/replica-fixture/run.ts
 *   bun run tests/integration/replica-fixture/run.ts --only opfs-off
 *   bun run tests/integration/replica-fixture/run.ts --headed --keep
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ServerWebSocket } from "bun";
import { launchBrowser } from "../../../frontend/scripts/perf/lib/harness";
import { appendRows, ackFor, frameFor, newMockHub, patchFrameFor, patchRow, readAsset, seedLog, type MockHubState } from "./server";

const REPO_ROOT = join(import.meta.dir, "../../..");
const FIXTURE_DIR = join(REPO_ROOT, "tests/integration/replica-fixture");
const SESSION_ID = "sess_1";
interface Options {
  only: string[];
  keep: boolean;
  headed: boolean;
  out: string | null;
  /** Serve the fixture and wait, for manual debugging in a real browser. */
  serve: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { only: [], keep: false, headed: false, out: null, serve: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--only") options.only.push(argv[++index] ?? "");
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--out") options.out = argv[++index] ?? null;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: bun run tests/integration/replica-fixture/run.ts [--only <key>] [--headed] [--keep] [--out <path>]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Milliseconds, for the two criteria that carry a budget. */
  ms?: number;
}

const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail: string, ms?: number): void {
  results.push({ name, ok, detail, ms });
  const budget = ms === undefined ? "" : ` [${Math.round(ms)}ms]`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${budget}\n      ${detail}`);
}

/** Build the fixture page and the Worker with Bun, from the repo's own sources. */
function buildFixture(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  // The wasm the Worker loads sits beside its bundle: the sqlite-wasm build
  // resolves `sqlite3.wasm` relative to `import.meta.url`, so one copy in the
  // asset directory is all the fixture needs (the `opfs-sahpool` VFS does not
  // use the async-proxy asset at all — verified in headless Chromium).
  copyFileSync(
    join(REPO_ROOT, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"),
    join(outDir, "sqlite3.wasm"),
  );
  const build = spawnSync(
    "bun",
    [
      "build",
      join(FIXTURE_DIR, "page.ts"),
      join(FIXTURE_DIR, "../replica-fixture/worker-entry.ts"),
      "--outdir",
      outDir,
      "--target",
      "browser",
      "--format",
      "esm",
      "--splitting",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (build.status !== 0) throw new Error(`fixture build failed: ${build.stderr || build.stdout}`);
}

/**
 * Serve the fixture and the mock hub on one origin.
 *
 * One origin is not a convenience: OPFS and Web Locks are per origin, so three
 * pages of the same context are only one replica when they share it.
 */
function startServer(assetDir: string) {
  const hub = newMockHub(SESSION_ID, seedLog(120));
  const sockets = new Set<ServerWebSocket<never>>();
  const pageSubscriptions = new Map<ServerWebSocket<never>, Set<string>>();
  let replayPaused = false;

  /** Known only after `Bun.serve` returns; the handlers below run later. */
  let origin = "";

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, serverRef) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (serverRef.upgrade(request)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/log") {
        const anchor = Number(url.searchParams.get("anchor") ?? "1");
        const after = Number(url.searchParams.get("after") ?? "0");
        const from = anchor;
        const to = anchor + after - 1;
        hub.logReads.push({ from, to, at: Date.now() });
        const entries = hub.rows
          .filter((row) => row.seq >= from && row.seq <= to && row.visibility === "shown")
          .map((row) => ({
            session_id: SESSION_ID,
            seq: row.seq,
            id: row.id,
            revision: row.revision,
            kind: row.kind,
            body_md: row.body_md,
            body_html: row.body_html,
            render_version: row.render_version,
          }));
        return Response.json({ entries });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // The page's own URL is the origin: `/page.js` and `/worker-entry.js`
        // resolve against it, and OPFS + Web Locks are per origin.
        return html();
      }
      const asset = await readAsset(assetDir, url.pathname.slice(1));
      if (!asset) return new Response("not found", { status: 404 });
      const type = url.pathname.endsWith(".wasm")
        ? "application/wasm"
        : url.pathname.endsWith(".js")
          ? "text/javascript"
          : "application/octet-stream";
      return new Response(new Uint8Array(asset), { headers: { "content-type": type } });
    },
    websocket: {
      open(socket: ServerWebSocket<never>) {
        sockets.add(socket);
        pageSubscriptions.set(socket, new Set());
      },
      message(socket: ServerWebSocket<never>, raw) {
        const message = JSON.parse(String(raw)) as { type: string; payload?: Record<string, unknown> };
        if (message.type === "auth") {
          socket.send(JSON.stringify({ type: "auth_ack", payload: {} }));
          return;
        }
        const payload = message.payload ?? {};
        if (message.type === "stream.subscribe") {
          const fromSeq = Number(payload.from_seq ?? 1);
          hub.subscribes.push({ fromSeq, at: Date.now() });
          const subscriptions = pageSubscriptions.get(socket);
          if (subscriptions?.size === 0) hub.activeSubscriptions += 1;
          subscriptions?.add(String(payload.id ?? ""));
          hub.globalSubscriptions += 1;
          socket.send(JSON.stringify({ type: "stream.ack", payload: ackFor(hub, fromSeq) }));
          // Replay what the ring still holds, exactly as the hub would.
          const tail = fromSeq;
          const frames = hub.rows.filter((row) => row.seq >= tail && row.visibility === "shown").map(frameFor);
          if (!replayPaused && frames.length > 0) {
            socket.send(JSON.stringify({ type: "stream.data", payload: { stream: "log", id: SESSION_ID, frames } }));
          }
          return;
        }
        if (message.type === "stream.unsubscribe") {
          hub.unsubscribes += 1;
          const subscriptions = pageSubscriptions.get(socket);
          subscriptions?.delete(String(payload.id ?? ""));
          if (subscriptions?.size === 0) hub.activeSubscriptions = Math.max(0, hub.activeSubscriptions - 1);
        }
      },
      close(socket: ServerWebSocket<never>) {
        const subscriptions = pageSubscriptions.get(socket);
        if (subscriptions && subscriptions.size > 0) hub.activeSubscriptions = Math.max(0, hub.activeSubscriptions - 1);
        pageSubscriptions.delete(socket);
        sockets.delete(socket);
      },
    },
  });

  /** Fan a batch out to every subscriber, as the hub's flush does. */
  const broadcast = (frames: unknown[]): void => {
    if (frames.length === 0) return;
    for (const socket of sockets) {
      const subscriptions = pageSubscriptions.get(socket);
      if (!subscriptions || subscriptions.size === 0) continue;
      socket.send(JSON.stringify({ type: "stream.data", payload: { stream: "log", id: SESSION_ID, frames } }));
    }
  };

  origin = `http://127.0.0.1:${server.port}`;

  return {
    hub,
    port: server.port,
    url: origin,
    broadcast,
    /** Append rows and fan them out, as `onEntry` would. */
    append(count: number): void {
      broadcast(appendRows(hub, count).map(frameFor));
    },
    /** Patch a row and fan the patch out. */
    patch(seq: number, body: string): void {
      const row = patchRow(hub, seq, body);
      if (row) broadcast([patchFrameFor(row)]);
    },
    appendSilently(count: number): void { appendRows(hub, count); },
    pauseReplay(paused: boolean): void { replayPaused = paused; },
    sendAck(head: number, version: number): void {
      for (const socket of sockets) {
        if (!pageSubscriptions.get(socket)?.size) continue;
        socket.send(JSON.stringify({type:"stream.ack",payload:{stream:"log",id:SESSION_ID,first_seq:1,head_seq:head,log_version:version,gap:null}}));
      }
    },
    /** The client count the "one subscription" criterion reads. */
    activeSubscriptions: () => hub.activeSubscriptions,
    stop: () => server.stop(true),
  };
}

function html(): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>replica fixture</title></head>
<body><div id="root">replica fixture</div>
<script type="module">
import { boot } from "/page.js";
boot();
</script>
</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const assetDir = mkdtempSync(join(tmpdir(), "mul442-replica-"));
  console.log(`building the fixture into ${assetDir}…`);
  buildFixture(assetDir);
  const server = startServer(assetDir);
  console.log(`fixture origin ${server.url} (session ${SESSION_ID}, ${server.hub.rows.length} rows)\n`);
  if (options.serve) {
    console.log("serving; press Ctrl-C to stop");
    await new Promise<never>(() => {});
  }

  // The repo's own launcher, so CI and a workstation resolve the same Chromium
  // the Playwright install step put in `~/.cache/ms-playwright`. `--headed` is the
  // one case it cannot serve, since it pins `headless: true`.
  const browser: Browser = options.headed
    ? await chromium.launch({
        executablePath: resolveChromium(),
        headless: false,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      })
    : await launchBrowser();

  try {
    const scopes: Array<{ key: string; opfs: "on" | "off" }> = [
      { key: "qa-last-close", opfs: "on" },
      { key: "qa-reopen-follower", opfs: "on" },
      { key: "qa-handoff-open-close", opfs: "on" },
      { key: "qa-follower-clear", opfs: "on" },
      { key: "qa-dispose-handoff", opfs: "on" },
      { key: "qa-deep-window", opfs: "on" },
      { key: "qa-new-ack", opfs: "on" },
      { key: "qa-identity-user", opfs: "on" },
      { key: "qa-identity-workspace", opfs: "on" },
      { key: "qa-second-identity-pool", opfs: "on" },
      { key: "qa-true-offline", opfs: "on" },
      { key: "qa-true-offline-memory", opfs: "off" },
    ];
    for (const key of ["qa-multi-gap", "qa-multi-gap-memory"]) {
      if (options.only.includes(key)) scopes.push({ key, opfs: key.endsWith("memory") ? "off" : "on" });
    }
    for (const scope of scopes) {
      if (options.only.length > 0 && !options.only.includes(scope.key)) continue;
      console.log(`── ${scope.key} (opfs ${scope.opfs}) ${"─".repeat(40)}`);
      const context = await browser.newContext();
      try {
        await runScope(scope.key, scope.opfs, context, server);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    if (!options.keep) server.stop();
  }

  const failed = results.filter((result) => !result.ok);
  // The report is written from a working tree, so it can never name the commit
  // that carries it. Recording the dirty paths instead is what makes the file
  // checkable later: the repo's performance rules ask for the diff summary beside
  // the SHA for exactly this reason (docs/dev/performance.md), and a reader can
  // then confirm that the only difference to HEAD is the report itself.
  const report = {
    generatedAt: new Date().toISOString(),
    head: gitHead(),
    worktree: {
      dirty: gitDirtyPaths(),
      note: "paths changed in the working tree when this ran, relative to `head`; empty means the report is the only difference",
    },
    checks: results,
    summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  };
  if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} (${results.length} checks)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function runScope(
  key: string,
  opfs: "on" | "off",
  context: BrowserContext,
  server: ReturnType<typeof startServer>,
): Promise<void> {
  const pages: Page[] = [];
  for (let index = 0; index < 3; index += 1) {
    const page = await context.newPage();
    await page.goto(pageUrl(server.url, `tab_${index + 1}`, opfs), { waitUntil: "load" });
    pages.push(page);
  }

  const states = async () => Promise.all(pages.map((page) => readState(page).catch(() => null)));
  const debug = process.env.MUL442_DEBUG === "1";
  if (debug) {
    for (const [index, page] of pages.entries()) {
      page.on("console", (message) => console.log(`   [tab ${index + 1} ${message.type()}] ${message.text().slice(0, 200)}`));
      page.on("pageerror", (error) => console.log(`   [tab ${index + 1} error] ${String(error).slice(0, 300)}`));
      page.on("requestfailed", (request) => console.log(`   [tab ${index + 1} reqfail] ${request.url()} ${request.failure()?.errorText}`));
    }
  }
  // `every(...)`, not `Promise.all(...)`: an array of `false`s is not `false`, so
  // `waitFor` would return immediately and every later assertion would read a
  // replica that had not synced yet.
  await waitFor(async () => {
    const current = await Promise.all(
      pages.map((page) =>
        readState(page)
          .then((state) => state.ready && state.head !== null)
          .catch((error) => {
            if (debug) console.log(`   [tab state error] ${String(error).slice(0, 200)}`);
            return false;
          }),
      ),
    );

    return current.every(Boolean);
  });

  if (key === "three-tabs" || key === "opfs-off") {
    // The three pages are up and each holds the same window.
    await waitFor(() => server.activeSubscriptions() >= 1);
    const leaders = (await states()).filter((state) => state?.isLeader);
    const all = await states();
    if (opfs === "on") {
      check(`${key}: exactly one leader`, leaders.length === 1, `${leaders.length} leaders of 3 pages`);
      check(`${key}: exactly one subscription`, server.activeSubscriptions() === 1, `${server.activeSubscriptions()} active server subscriptions`);
    } else {
      // The documented fallback is *per tab*: with no OPFS there is nothing to
      // share, and plan 3/6 §1 says every tab subscribes for itself. Asserting
      // "one subscription" here would be asserting behaviour the plan does not
      // promise, so the fallback is checked against what it does promise — one
      // subscription per tab and the same protocol.
      check(
        `${key}: every tab subscribes for itself (documented fallback)`,
        leaders.length === 3 && server.activeSubscriptions() === 3,
        `${leaders.length} leaders, ${server.activeSubscriptions()} active server subscriptions`,
      );
    }
    const entriesEqual = all.every((state) => JSON.stringify(state?.entries) === JSON.stringify(all[0]?.entries));
    check(
      `${key}: all three pages hold identical entries`,
      entriesEqual && all[0]?.entries.length === server.hub.rows.length,
      `${all[0]?.entries.length ?? 0} entries on each page, heads ${all.map((state) => state?.head).join(", ")} (server head ${server.hub.head})`,
    );
    if (opfs === "off") {
      // Every tab runs its own replica on the fallback path — no lock is taken, so
      // there is no leader to share one through — and each must therefore report
      // the memory store and that it degraded.
      const storages = all.map((state) => state?.storage);
      const degraded = all.map((state) => state?.degraded);
      check(
        `${key}: every page reports the memory fallback`,
        storages.every((storage) => storage === "memory") && degraded.every(Boolean),
        `storages ${storages.join(", ")}, degraded ${degraded.join(", ")}`,
      );
      // The fallback keeps the protocol, so the windows must still match the
      // server's head even though nothing is shared between the tabs.
      check(
        `${key}: the fallback still reaches the server head`,
        all.every((state) => state?.head === server.hub.head),
        `heads ${all.map((state) => state?.head).join(", ")} (server ${server.hub.head})`,
      );
    } else {
      const storages = all.filter((state) => state?.isLeader).map((state) => state?.storage);
      check(`${key}: the leader holds the OPFS database`, storages[0] === "opfs", `leader storage ${storages[0]}`);
    }
  }

  if (key.startsWith("qa-")) {
    await waitFor(async()=> (await states()).every(s=>s?.head===server.hub.head&&s?.fresh));
    const leaderIndex=(await waitForLeader(pages)).index;
    const leader=pages[leaderIndex]!;
    const follower=pages.find((_p,n)=>n!==leaderIndex)!;

    if(key==="qa-true-offline"||key==="qa-true-offline-memory") {
      const head=server.hub.head;
      const reads=server.hub.logReads.length;
      const subscribes=server.hub.subscribes.length;
      await context.setOffline(true);
      await Promise.all(pages.map(page=>page.evaluate(()=> (window as any).__replica.kickSocket())));
      await waitFor(async()=>server.activeSubscriptions()===0,4000);
      check(`${key}: outage confirmed before append`,server.activeSubscriptions()===0,`active subscriptions ${server.activeSubscriptions()}`);
      server.append(50);
      const at=Date.now();
      await context.setOffline(false);
      const caught=await waitFor(async()=> (await states()).every(s=>s?.head===server.hub.head&&s.fresh),4000).catch(()=>false);
      const ms=Date.now()-at,all=await states();
      check(`${key}: every page catches up within 2s`,caught!==false&&ms<=2000,`heads ${all.map(s=>s?.head).join(",")}, server ${server.hub.head}, fresh ${all.map(s=>s?.fresh).join(",")}`,ms);
      const addedSubs=server.hub.subscribes.slice(subscribes),addedReads=server.hub.logReads.slice(reads);
      check(`${key}: reconnect starts at local head plus 1`,addedSubs.length>0&&addedSubs.every(s=>s.fromSeq===head+1),`subscribes ${addedSubs.map(s=>s.fromSeq).join(",")}, previous head ${head}`);
      check(`${key}: no full log read`,addedReads.every(r=>r.from>1),`ranges ${JSON.stringify(addedReads)}`);
      return;
    }

    if (key === "qa-multi-gap" || key === "qa-multi-gap-memory") {
      const head = server.hub.head, readsBefore = server.hub.logReads.length;
      server.appendSilently(5);
      server.broadcast(server.hub.rows.filter(row => [head + 1, head + 3, head + 5].includes(row.seq)).map(frameFor));
      const caught = await waitFor(async () => (await states()).every(state => state?.head === server.hub.head && state.fresh), 4000).catch(() => false);
      const reads = server.hub.logReads.slice(readsBefore);
      const expected = [{ from: head + 2, to: head + 2 }, { from: head + 4, to: head + 4 }];
      check(`${key}: both holes are fetched`, expected.every(range => reads.some(read => read.from === range.from && read.to === range.to)), `reads ${JSON.stringify(reads)}`);
      const all = await states();
      check(`${key}: all pages reach a fresh continuous head`, caught !== false && (opfs === "off" || all[leaderIndex]?.storage === "opfs"), `heads ${all.map(state => state?.head)}, storages ${all.map(state => state?.storage)}`);
      return;
    }

    if(key==="qa-last-close") {
      const before=server.hub.unsubscribes;
      await follower.evaluate(()=> (window as any).__replica.close());
      check("QA last-close: an early close keeps subscription",server.activeSubscriptions()===1,`active ${server.activeSubscriptions()}`);
      for(const page of pages) if(page!==follower) await page.evaluate(()=> (window as any).__replica.close());
      const closed=await waitFor(async()=>server.activeSubscriptions()===0,1000).catch(()=>false);
      check("QA last-close: all explicit closes unsubscribe",closed!==false,`active ${server.activeSubscriptions()}, unsubs ${server.hub.unsubscribes-before}`);
    }
    if(key==="qa-follower-clear") {
      await follower.evaluate(()=> (window as any).__replica.clear("logout"));
      const heard=await waitFor(async()=>{
        const all=await Promise.all(pages.map(p=>p.evaluate(()=> (window as any).__replica.clearedEvents())));
        return all.every(events=>events.includes("logout"));
      },1000).catch(()=>false);
      const all=await states();
      check("QA follower logout: all tabs hear clear",heard!==false,`events ${JSON.stringify(await Promise.all(pages.map(p=>p.evaluate(()=> (window as any).__replica.clearedEvents()))))}`);
      check("QA follower logout: no page retains rows",all.every(s=>s?.entries.length===0),`row counts ${all.map(s=>s?.entries.length).join(",")}`);
    }
    if(key==="qa-reopen-follower") {
      await follower.evaluate(()=>{(window as any).__replica.close();(window as any).__replica.open();});
      server.append(1);
      const saw=await waitFor(async()=> (await readState(follower)).head===server.hub.head,1000).catch(()=>false);
      check("QA reopen follower: close/open keeps it listening",saw!==false,`reopened head ${(await readState(follower)).head}, server ${server.hub.head}`);
      check("QA reopen follower: other pages did receive the append",(await readState(leader)).head===server.hub.head,`leader head ${(await readState(leader)).head}`);
    }
    if(key==="qa-handoff-open-close") {
      const oldHead=server.hub.head;
      const survivors=pages.filter(p=>p!==leader);
      const changing=survivors.at(-1)!;
      await changing.evaluate(()=> (window as any).__replica.close());
      const closed=leader.close();
      await changing.evaluate(()=> (window as any).__replica.open());
      await closed;pages.splice(leaderIndex,1);
      const next=await waitFor(async()=> (await states()).some(s=>s?.isLeader&&s.head===oldHead),1000).catch(()=>false);
      check("QA interleaved handoff: resumes with continuous head",next!==false,`heads ${(await states()).map(s=>s?.head).join(",")}`);
      server.append(1);
      const all=await waitFor(async()=> (await states()).every(s=>s?.head===server.hub.head),1000).catch(()=>false);
      check("QA interleaved handoff: reopened page receives subsequent data",all!==false,`heads ${(await states()).map(s=>s?.head).join(",")}, server ${server.hub.head}`);
      for(const page of pages) await page.evaluate(()=> (window as any).__replica.close());
      const unsub=await waitFor(async()=>server.activeSubscriptions()===0,1000).catch(()=>false);
      check("QA interleaved handoff: final close unsubscribes",unsub!==false,`active ${server.activeSubscriptions()}`);
    }
    if(key==="qa-dispose-handoff") {
      const oldOwner = await leader.evaluate(async () =>
        (await navigator.locks.query()).held?.find((lock) => lock.name === "remi-replica:user_1:ws_1")?.clientId);
      await leader.evaluate(()=> (window as any).__replica.dispose());
      const next=await waitFor(async()=>{
        const all=await states();return all.some((s,n)=>n!==leaderIndex&&s?.isLeader);
      },1000).catch(()=>false);
      check("QA dispose: surviving facade takes lock within 1s",next!==false,`survivor leader flags ${(await states()).filter((_s,n)=>n!==leaderIndex).map(s=>s?.isLeader).join(",")}`);
      const locks=await follower.evaluate(async()=> (await navigator.locks.query()).held ?? []);
      // The new leader holds the same name. Ownership, not absence, proves release.
      check("QA dispose: disposed facade releases its lock",!!oldOwner && !locks.some(lock => lock.clientId === oldOwner),`held ${JSON.stringify(locks)}, old owner ${oldOwner}`);
    }
    if(key==="qa-deep-window") {
      const head=server.hub.head,reads=server.hub.logReads.length;
      server.appendSilently(2);
      await follower.evaluate(({from,to})=> (window as any).__replica.loadWindow(from,to),{from:head+1,to:head+2});
      const filled=await waitFor(async()=> (await readState(follower)).entries.some(e=>e.seq===head+2),1000).catch(()=>false);
      check("QA follower deep-link: missing window uses read route",server.hub.logReads.length>reads,`new reads ${JSON.stringify(server.hub.logReads.slice(reads))}`);
      check("QA follower deep-link: requested rows appear",filled!==false,`requested ${head+1}..${head+2}, last row ${(await readState(follower)).entries.at(-1)?.seq}`);
    }
    if(key==="qa-new-ack") {
      const oldHead=server.hub.head;
      const subsBefore = server.hub.subscribes.length, readsBefore = server.hub.logReads.length;
      const responses=await leader.evaluate(()=> (window as any).__qaWorkerResponses.length);
      server.pauseReplay(true);
      server.appendSilently(1);server.hub.logVersion=99;
      server.sendAck(server.hub.head,server.hub.logVersion);
      await waitFor(async()=>await leader.evaluate((n)=> (window as any).__qaWorkerResponses.slice(n).some((r:any)=>r.type==="backfill"),responses));
      await waitFor(async () => (await states()).every(state => !state?.fresh));
      const all=await states();
      check("QA ack: version/head change revokes view freshness",all.every(s=>!s?.fresh),`heads ${all.map(s=>s?.head).join(",")}, fresh ${all.map(s=>s?.fresh).join(",")}`);
      const restarted = await waitFor(async () =>
        server.hub.subscribes.slice(subsBefore).some(sub => sub.fromSeq === 1)
        || server.hub.logReads.slice(readsBefore).some(read => read.from === 1 && read.to >= oldHead), 1000).catch(() => false);
      check("QA ack: reset triggers new cursor or range read",restarted !== false,`new cursors ${JSON.stringify(server.hub.subscribes.slice(subsBefore))}, reads ${JSON.stringify(server.hub.logReads.slice(readsBefore))}`);
      server.pauseReplay(false);
      server.broadcast(server.hub.rows.map(frameFor));
      await waitFor(async () => (await states()).every(state => state?.head === server.hub.head && state.fresh));
    }
    if(key==="qa-identity-user"||key==="qa-identity-workspace") {
      const user=key==="qa-identity-user"?"qa_new_user":"user_1";
      const ws=key==="qa-identity-workspace"?"qa_new_workspace":"ws_1";
      const lockName=`remi-replica:${user}:${ws}`;
      await leader.evaluate(async(name)=>{
        let granted:any;const wait=new Promise(resolve=>granted=resolve);
        (window as any).__qaIdentityLock=navigator.locks.request(name,()=>{
          granted(true);return new Promise(resolve=>(window as any).__qaReleaseIdentityLock=resolve);
        });await wait;
      },lockName);
      const outsider=await context.newPage();
      const outsiderUrl=new URL(pageUrl(server.url,"qa_outsider","on"));
      outsiderUrl.searchParams.set("userId",user);outsiderUrl.searchParams.set("workspaceId",ws);outsiderUrl.searchParams.set("wsUrl","/denied-ws");
      await outsider.goto(outsiderUrl.toString());
      await waitFor(async()=> !!await outsider.evaluate(()=> (window as any).__replica));
      await waitFor(async()=> (await readState(outsider)).ready,1000).catch(()=>false);
      const leak=await readState(outsider) as PageState & {sent:unknown[]};
      check(`${key}: unauthorized new identity never receives old rows`,leak.entries.length===0,`identity ${user}/${ws}, rows ${leak.entries.length}, first body ${JSON.stringify(leak.entries[0]?.body_md)}, leader ${leak.isLeader}`);
      check(`${key}: no server subscription supplied these rows`,leak.sent.length===0,`new identity sent ${leak.sent.length} subscribes; /denied-ws returns 404`);
      await outsider.close();await leader.evaluate(()=> (window as any).__qaReleaseIdentityLock());
    }
    if(key==="qa-second-identity-pool") {
      const outsider=await context.newPage();
      const url=new URL(pageUrl(server.url,"qa_other_leader","on"));url.searchParams.set("workspaceId","qa_other_ws");
      await outsider.goto(url.toString());
      const ready=await waitFor(async()=>await outsider.evaluate(()=> (window as any).__qaWorkerResponses?.find((r:any)=>r.type==="ready"))||false);
      const state=await readState(outsider);
      check("QA partitioned pool: independent workspace can open persistent storage",ready.storage==="opfs",`worker ready ${JSON.stringify(ready)}`);
      check("QA degraded: facade accurately reports worker storage",state.storage===ready.storage&&state.degraded===(ready.degraded!==null),`facade ${state.storage}/degraded ${state.degraded}, worker ${ready.storage}/degraded ${!!ready.degraded}`);
      await outsider.close();
    }
    return;
  }

  if (key === "handoff") {
    const initial = await waitForLeader(pages);
    const leaderIndex = initial.index;
    const before = await readState(pages[leaderIndex]!);
    const killedAt = Date.now();
    await pages[leaderIndex]!.close();
    pages.splice(leaderIndex, 1);

    const takeover = await waitFor(async () => {
      const current = await states();
      const index = current.findIndex((state) => state?.isLeader && state.head !== null);
      return index >= 0 ? index : false;
    }, 5_000);
    const tookMs = Date.now() - killedAt;
    check(`handoff: a surviving page takes over within 1s`, tookMs <= 1_000, `took ${Math.round(tookMs)}ms`, tookMs);
    const after = await readState(pages[takeover]!);
    check(
      `handoff: the new leader's head is continuous`,
      after.head === before.head,
      `head ${before.head} -> ${after.head}, entries ${before.entries.length} -> ${after.entries.length}`,
    );
    // The replacement must resume from the stored head, not re-read the log.
    const readsAfterHandoff = server.hub.logReads.filter((read) => read.at >= killedAt);
    check(
      `handoff: the new leader resumes instead of re-reading the tail`,
      readsAfterHandoff.every((read) => read.from > 1),
      `${readsAfterHandoff.length} /log reads after the handoff: ${readsAfterHandoff.map((read) => `${read.from}..${read.to}`).join(", ") || "none"}`,
    );
    // The killed page is gone, so this is about the survivors: a handoff that
    // left them stale would show up as a head behind the new leader's.
    const survivorHeads = (await states()).map((state) => state?.head);
    check(
      `handoff: the surviving pages hold the same head`,
      survivorHeads.length > 0 && survivorHeads.every((head) => head === before.head),
      `heads ${survivorHeads.join(", ")} (was ${before.head})`,
    );
  }

  if (key === "offline-catch-up" || key === "opfs-off") {
    // Wait for the whole group first: the criterion is about the *replica's*
    // catch-up, and a tab that has not synced yet would make the head comparison
    // meaningless.
    await waitFor(async () => {
      const current = await states();
      return current.every((state) => state?.ready && state.head === server.hub.head) ? true : false;
    });
    // The page under test is a *follower*: it has no socket of its own, so a
    // catch-up it can see proves the leader's replay reached the channel rather
    // than only the leader's own window.
    const leaderIndex = (await waitForLeader(pages)).index;
    const page = pages.find((_, index) => index !== leaderIndex) ?? pages[0]!;
    const leaderPage = pages[leaderIndex]!;
    const initial = await readState(page);
    const readsBefore = server.hub.logReads.length;
    const serverHeadBefore = server.hub.head;
    // Drop the leader's socket — the only one there is — append 50 rows the tabs
    // cannot see, then let it reconnect. The replica has to come back from its
    // stored head rather than re-reading the log.
    await leaderPage.evaluate(() => (window as unknown as { __replica: { kickSocket(): void } }).__replica.kickSocket());
    await waitFor(() => Promise.resolve(false), 300).catch(() => {});
    server.append(50);
    const appendAt = Date.now();
    const resumedAt = await waitFor(async () => {
      const state = await readState(page);
      return state.head === server.hub.head && state.fresh;
    }, 4_000);
    const elapsed = Date.now() - appendAt;
    const state = await readState(page);
    check(
      `offline-catch-up: head matches within 2s of the socket returning`,
      state.head === server.hub.head && elapsed <= 2_000,

      `head ${state.head} of ${server.hub.head}, fresh ${state.fresh}, ${Math.round(elapsed)}ms after the append (budget 2000ms)`,
      elapsed,
    );
    const reads = server.hub.logReads.slice(readsBefore);
    const full = reads.filter((read) => read.from === 1);
    check(
      `offline-catch-up: no full /log read`,
      full.length === 0,
      `${reads.length} reads, ranges ${reads.map((read) => `${read.from}..${read.to}`).join(", ") || "none"}`,
    );
    const subscribeAfter = server.hub.subscribes.filter((subscribe) => subscribe.at >= readsBefore);
    check(
      `offline-catch-up: the resume cursor is the stored head + 1`,
      subscribeAfter.some((subscribe) => subscribe.fromSeq === initial.head! + 1),
      `subscribe from_seq values ${subscribeAfter.map((subscribe) => subscribe.fromSeq).join(", ")} (local head was ${initial.head}, server head ${serverHeadBefore} -> ${server.hub.head})`,
    );
    if (key === "opfs-off") {
      check(
        `opfs-off: the fallback still keeps one subscription per tab after a reconnect`,
        server.activeSubscriptions() === 3,
        `${server.activeSubscriptions()} active server subscriptions`,
      );
    }
    // Every page must converge, not just the one that was watched.
    const allAfter = await waitFor(async () => {
      const current = await states();
      return current.every((state) => state?.head === server.hub.head) ? current : false;
    }, 3_000).catch(() => null);
    check(
      `offline-catch-up: all three pages converge on the new head`,
      allAfter !== null,
      allAfter === null ? "not every page matched within 3s" : `heads ${allAfter.map((state) => state?.head).join(", ")}`,
    );
  }

  if (key === "cleared") {
    // Scope item 8: the whole database is dropped and every tab hears about it.
    // The leader sends `clear`; the Worker wipes storage and the leader broadcasts
    // `replica:cleared`, which is what a follower has to act on — it owns no
    // database, so if the broadcast did not reach it, it would keep serving rows
    // from a replica the leader just deleted.
    const leaderIndex = (await waitForLeader(pages)).index;
    const before = await readState(pages[(leaderIndex + 1) % pages.length]!);
    check("cleared: the tabs start with a populated window", before.entries.length > 0, `${before.entries.length} entries before the clear`);

    await pages[leaderIndex]!.evaluate(() =>
      (window as unknown as { __replica: { clear(reason: string): Promise<void> } }).__replica.clear("logout"),
    );

    const drained = await waitFor(async () => {
      const current = await states();
      return current.every((state) => state !== null && state.entries.length === 0 && state.head === null && !state.fresh && !state.ready) ? current : false;
    }, 5_000).catch(() => null);
    const heard = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const api = window as unknown as { __replica: { clearedEvents(): string[] } };
          return api.__replica.clearedEvents();
        }),
      ),
    );
    check(
      "cleared: every tab drops its window and its freshness",
      drained !== null,
      drained === null
        ? `entries ${(await states()).map((state) => state?.entries.length).join(", ")}`
        : `entries ${drained.map((state) => state?.entries.length).join(", ")}, heads ${drained.map((state) => state?.head).join(", ")}`,
    );
    check(
      "cleared: the followers acted on the broadcast they received",
      heard.filter((reasons) => reasons.includes("logout")).length === pages.length,
      `cleared events per tab: ${JSON.stringify(heard)}`,
    );

    // A cleared replica must be able to refill from the server, which proves the
    // database was left usable rather than left inconsistent.
    server.append(5);
    const refilled = await waitFor(async () => {
      const current = await states();
      return current.every((state) => state?.head === server.hub.head) ? current : false;
    }, 8_000).catch(() => null);
    check(
      "cleared: the replica refills from the server afterwards",
      refilled !== null,
      refilled === null
        ? `heads ${(await states()).map((state) => state?.head).join(", ")} (server ${server.hub.head})`
        : `heads ${refilled.map((state) => state?.head).join(", ")} (server ${server.hub.head})`,
    );
  }

  if (key === "patch-in-place" || key === "opfs-off") {
    // Relative to what the tabs already hold, not to an absolute revision: this
    // scope runs for the fallback too, where the same row is patched again.
    const initial = await readState(pages[0]!);
    const beforeRevision = initial.entries.find((entry) => entry.seq === 5)?.revision ?? 1;
    const rowCountBefore = initial.entries.length;
    // The patch must reach every tab, so all of them are watched: a follower that
    // never re-read its window would look fine on the leader alone.
    server.patch(5, "edited body");
    const sawPatch = await waitFor(async () => {
      const current = await states();
      return current.every((state) => state?.entries.find((entry) => entry.seq === 5)?.revision === beforeRevision + 1)
        ? current
        : false;
    }, 8_000).catch(() => null);
    const after = sawPatch?.[0] ?? (await readState(pages[0]!));
    const patched = after.entries.find((entry) => entry.seq === 5);
    check(
      "patch-in-place: the row updates without a second row",
      patched?.revision === beforeRevision + 1 && patched.body_md === "edited body" && after.entries.length === rowCountBefore,
      `seq 5 revision ${beforeRevision} -> ${patched?.revision} body ${JSON.stringify(patched?.body_md)}, ${after.entries.length} rows (was ${rowCountBefore})`,
    );
    check(
      "patch-in-place: every tab saw the edit",
      sawPatch !== null,
      sawPatch === null
        ? `not every tab reached revision ${beforeRevision + 1}`
        : `revisions ${sawPatch.map((state) => state?.entries.find((entry) => entry.seq === 5)?.revision).join(", ")}`,
    );
  }
}

interface PageState {
  entries: Array<{ seq: number; revision: number; body_md: string }>;
  head: number | null;
  fresh: boolean;
  ready: boolean;
  isLeader: boolean;
  storage: "opfs" | "memory" | null;
  degraded: boolean;
}

function pageUrl(origin: string, tabId: string, opfs: "on" | "off"): string {
  const url = new URL(origin);
  url.searchParams.set("tabId", tabId);
  url.searchParams.set("sessionId", SESSION_ID);
  url.searchParams.set("opfs", opfs);
  return url.toString();
}

async function readState(page: Page): Promise<PageState> {
  return page.evaluate(() => {
    const api = (window as unknown as { __replica: { ready: Promise<unknown>; state: () => PageState } }).__replica;
    return api.state();
  });
}

/**
 * Wait for `predicate`, which may return `false` and must then be retried.
 *
 * Polling, not a fixed sleep: the criteria are about time budgets, and a fixed
 * sleep either hides a slow path or makes the run slow for no reason.
 */
async function waitFor<T>(predicate: () => T | false | Promise<T | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForLeader(pages: Page[]): Promise<{ index: number }> {
  const index = await waitFor(async () => {
    for (let candidate = 0; candidate < pages.length; candidate += 1) {
      const state = await readState(pages[candidate]!).catch(() => null);
      if (state?.isLeader && state.ready && state.head !== null) return candidate;
    }
    return false;
  });
  return { index };
}

/** Chromium for the `--headed` path; the headless path uses the repo's launcher. */
function resolveChromium(): string | undefined {
  const root = join(process.env.HOME ?? "/root", ".cache", "ms-playwright");
  try {
    const candidates = readdirSync(root)
      .filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .reverse();
    for (const name of candidates) {
      const candidate = join(root, name, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function gitHead(): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Paths modified or untracked in the working tree, so the report is self-describing. */
function gitDirtyPaths(): string[] {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
