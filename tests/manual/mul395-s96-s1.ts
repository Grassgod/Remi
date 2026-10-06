/** Local S1 contract guard: S7 memory fixture, production Next build/start, no remote state. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import { seedZeroJumpFixture } from "../integration/zero-jump-fixture";
import { scrubInheritedEnv, HERMETIC_ENV_RUN_ROOT_PATHS } from "../setup/hermetic-env-policy";
import { installFirstScreenHotspotIds } from "../fixtures/multiremi/first-screen-hotspots-normalize";

const root = resolve(import.meta.dir, "../..");
const webDir = process.env.MUL395_S1_WEB_DIR ?? join(root, "frontend/apps/web");
const out = process.env.MUL395_S1_OUT ?? "/tmp/mul395-s96-s1";
mkdirSync(out, { recursive: true });
scrubInheritedEnv();
for (const [name, relative] of Object.entries(HERMETIC_ENV_RUN_ROOT_PATHS)) process.env[name] = join(out, "fixture-state", relative);
const apiPort = 16695, webPort = 3395;
const db = openSqliteDatabase(":memory:");
const restoreFixtureClock = installFirstScreenHotspotIds();
const store = new MultiremiStore(db);
const fixture = await seedZeroJumpFixture(store);
const agent = store.getAgent("agt_zerojump")!;
store.createProject({ id: "prj_s96", title: "S1 project", workspaceId: "local" });
store.createSkill({ id: "skl_s96", name: "S1 skill", description: "S1 fixture", workspaceId: "local", files: [{ path: "reference.md", content: "# S1 fixture" }] });
store.createAutopilot({ id: "atp_s96", title: "S1 autopilot", assigneeId: agent.id, workspaceId: "local" });
store.registerRuntime({ id: "rt_s96", name: "S1 runtime", provider: "codex", workspaceId: "local", ownerId: fixture.userId });
store.updateIssue(fixture.shortIssueId, { assigneeType: "member", assigneeId: fixture.memberId });
const review = store.createIssue({ id: "iss_s96_review", title: "S1 workbench item", status: "in_review", workspaceId: "local", assigneeType: "member", assigneeId: fixture.memberId });
const chat = store.createChatSession({ id: "chat_s96", agentId: agent.id, creatorId: fixture.userId, title: "S1 message fixture" });
store.sendChatMessage(chat.id, { body: "first message" });
store.sendChatMessage(chat.id, { body: "latest message" });
// The target is read, on API page five, but the browser injects it into page one.
db.run("UPDATE multiremi_inbox_items SET read = 1, created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?", [fixture.inboxItemId]);
for (let i = 0; i < 410; i++) db.run(`INSERT INTO multiremi_inbox_items
  (id,workspace_id,member_id,recipient_type,recipient_id,severity,actor_type,type,title,body,details,read,archived,created_at)
  VALUES (?,'local',?,'member',?,'info','system','autopilot_run_failed',?,'',?,1,0,?)`,
  [`inb_s96_${i}`, fixture.memberId, fixture.memberId, `Other notification ${i}`,
    JSON.stringify({ outcome: { kind: "changes", text: null, links: [{ kind: "pull_request", url: `http://127.0.0.1:${webPort}/skills` }] } }),
    new Date(Date.UTC(2026, 8, 26, 9, 0, i)).toISOString()]);
restoreFixtureClock();
const minted = await store.createAccessToken({ name: "S1 local fixture", type: "pat", userId: fixture.userId, workspaceId: "local" });
const api = startMultiremiServer({ store, port: apiPort, hostname: "127.0.0.1", authToken: "s96-s1-local-fixture-root", backgroundJobs: false });
let web: ReturnType<typeof Bun.spawn> | undefined;
const childEnv = { ...process.env, REMOTE_API_URL: `http://127.0.0.1:${apiPort}`, NEXT_BUILD_CPUS: "4", NEXT_TELEMETRY_DISABLED: "1" };
try {
  for (const file of ["probe.log", "probe-errors.log", "web.log", "web-errors.log"]) writeFileSync(join(out, file), "");
  if (process.env.MUL395_S1_SKIP_BUILD !== "1") {
    console.log("S1: building production Web");
    const build = Bun.spawn(["bun", "run", "build"], { cwd: webDir, env: childEnv,
      stdout: Bun.file(join(out, "build.log")), stderr: Bun.file(join(out, "build-errors.log")) });
    if (await build.exited !== 0) throw new Error("next build failed; see build log");
  }
  web = Bun.spawn(["bun", "x", "next", "start", "--hostname", "127.0.0.1", "--port", String(webPort)], {
    cwd: webDir, env: childEnv,
    stdout: Bun.file(join(out, "web.log")), stderr: Bun.file(join(out, "web-errors.log")),
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`http://127.0.0.1:${webPort}/login`).then(r => r.ok, () => false)) break;
    await Bun.sleep(200);
    if (attempt === 99) throw new Error("next start did not become ready");
  }
  const args = ["bun", "run", "frontend/scripts/perf/page-speed.ts", "--base-url", `http://127.0.0.1:${webPort}`,
    "--rounds", "2", "--name", "MUL-395-s96-contract", "--out", out,
    "--issue-short", fixture.shortIssueId, "--issue-long", fixture.longIssueId,
    "--issue-xlong", "", "--issue-running", fixture.runningIssueId, "--inbox-item", fixture.inboxItemId];
  if (process.env.MUL395_S1_ONLY) args.push("--only", process.env.MUL395_S1_ONLY);
  const probe = Bun.spawn(args, { cwd: root, env: { ...childEnv, MULTIREMI_QA_WEB_TOKEN: minted.token },
    stdout: Bun.file(join(out, "probe.log")), stderr: Bun.file(join(out, "probe-errors.log")) });
  if (await probe.exited !== 0) throw new Error("S1 script failed; see probe log");
  const report = await Bun.file(join(out, "MUL-395-s96-contract.json")).json();
  const failures: string[] = [];
  for (const scenario of report.scenarios) {
    if (scenario.skipped) { failures.push(`${scenario.key}/${scenario.mode}: skipped ${scenario.skipReason}`); continue; }
    for (const round of scenario.rounds) {
      if (round.error) failures.push(`${scenario.key}/${scenario.mode}: ${round.error}`);
      if (round.firstRealMs === null || round.jumpCount === null || !round.firstRealKeys?.length)
        failures.push(`${scenario.key}/${scenario.mode}: missing real-row observation`);
      const expectedKey = ({ "page-projects": "prj_s96", "page-autopilots": "atp_s96", "page-settings": "account-name" } as Record<string, string>)[scenario.key];
      if (expectedKey && !round.firstRealKeys?.includes(expectedKey)) failures.push(`${scenario.key}: observed the wrong route's rows`);
      if (round.selectorMode === "legacy" || scenario.selectorMode !== "contract") failures.push(`${scenario.key}: legacy fallback`);
      if (scenario.key === "detail-running" && (round.anchorName !== "agent-stream" || round.anchorVisibleMs === null)) failures.push("running anchor mismatch");
      if (scenario.key === "page-chat" && (round.anchorName !== "latest-message" || round.anchorVisibleMs === null)) failures.push("chat anchor mismatch");
      if (scenario.key === "deeplink" && scenario.mode === "warm" &&
        (round.clickedRowKey !== fixture.inboxItemId || new URL(round.finalUrl).searchParams.get("issue") !== fixture.longIssueId)) failures.push("deeplink exact row/URL mismatch");
    }
  }
  for (const file of ["MUL-395-s96-contract.json", "MUL-395-s96-contract.md", "MUL-395-s96-contract.html"]) {
    if ((await Bun.file(join(out, file)).text()).includes(minted.token)) failures.push("credential in artifact");
  }
  writeFileSync(join(out, "contract-verdict.json"), JSON.stringify({ fixture: "S7 + list/chat/page-five-read-notification", viewport: "1440x900", reviewIssue: review.id, failures }, null, 2));
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`S1 contract guard: ${report.scenarios.length} scenarios, 2 rounds, all observed`);
} finally {
  if (web) { web.kill("SIGTERM"); await web.exited; }
  api.stop(true);
  db.close();
}
