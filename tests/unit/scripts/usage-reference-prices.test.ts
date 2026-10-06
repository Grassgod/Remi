import { afterEach, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "../../../packages/server/src/store/db/postgres.js";
import { ensureUsageAccountingSchema } from "../../../packages/server/src/store/usage-accounting.js";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyReferencePlan, buildReferencePlan, catalogDigest, databaseTarget, digest, observeSkus, priceRepository, referenceCatalog, type ObservedSku, type ReferencePlan, type ReferenceRoute } from "../../../scripts/import-usage-reference-prices.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import type { SetUsagePriceInput } from "../../../packages/contracts/src/usage-accounting.js";

afterEach(resetMultiremiTestEnv);
const target = "postgres://127.0.0.1:55486/postgres";
const referenceAdminUrl = process.env.MULTIREMI_TEST_REFERENCE_DATABASE_URL ?? process.env.MULTIREMI_TEST_POSTGRES_URL;
const from = referenceCatalog.applicability.earliest_effective_from;
const route = (overrides: Partial<ReferenceRoute> = {}): ReferenceRoute => ({ provider: "claude", connection_id: "test-gateway", evidence: "Dummy unit-test reviewed gateway route", catalog_commit: referenceCatalog.source.commit, effective_from: from, effective_to: null, ...overrides });
const observed = (overrides: Partial<ObservedSku> = {}): ObservedSku => ({ provider: "claude", model: "deepseek-chat", model_source: "provider_reported", connection_id: "test-gateway", units: 1, first_at: from, last_at: from, ...overrides });
function plan(rows: ObservedSku[] = [observed()], overrides: Partial<Parameters<typeof buildReferencePlan>[0]> = {}): ReferencePlan {
  return buildReferencePlan({ target, workspace_id: "local", routes: [route()], observed: rows, existing: [], now: from, ...overrides });
}
function configured(overrides: Partial<SetUsagePriceInput> = {}): SetUsagePriceInput {
  return { ...plan().decisions[0]!.price!, source: "configured", source_url: null, effective_from: "2026-09-01T00:00:00.000Z", input_per_million: 7, ...overrides };
}

async function withReferenceDatabase(run: (url: string) => Promise<void>): Promise<void> {
  if (!referenceAdminUrl) throw new Error("Reference PostgreSQL test URL is required");
  let url: URL;
  try { url = new URL(referenceAdminUrl); } catch { throw new Error("Invalid reference PostgreSQL test target"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error("Invalid reference PostgreSQL test target");
  const name = `multiremi_reference_test_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!/^multiremi_reference_test_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid isolated reference database name");
  const admin = new Bun.SQL(referenceAdminUrl, { max: 1, connectionTimeout: 5 });
  let created = false;
  try {
    try {
      expect(await admin.unsafe("SELECT datname FROM pg_database WHERE datname=$1", [name])).toHaveLength(0);
      await admin.unsafe(`CREATE DATABASE ${name}`);
    } catch (error) { throw safeDatabaseFailure(error, "create"); }
    created = true;
    url.pathname = `/${name}`;
    await run(url.toString());
  } finally {
    try {
      // Drop only a database whose CREATE succeeded in this invocation. Active
      // connections or any other cleanup error fail the test; never force-drop.
      if (created) {
        try { await admin.unsafe(`DROP DATABASE ${name}`); }
        catch (error) { throw safeDatabaseFailure(error, "cleanup"); }
      }
    } finally {
      try { await admin.end(); } catch (error) { throw safeDatabaseFailure(error, "close"); }
    }
  }
}

function safeDatabaseFailure(error: unknown, operation: string): Error {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "UNKNOWN";
  return new Error(`Reference PostgreSQL fixture ${operation} failed (${code})`);
}

function removeReferenceDirectory(dir: string): void {
  const resolved = realpathSync(dir);
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()
    || dirname(resolved) !== realpathSync(tmpdir()) || !basename(resolved).startsWith("reference-cli-")) throw new Error("Invalid reference fixture directory");
  for (const name of readdirSync(resolved)) {
    const entry = lstatSync(join(resolved, name));
    if (!["routes.json", "plan.json"].includes(name) || entry.isSymbolicLink() || !entry.isFile()) throw new Error("Unexpected reference fixture cleanup target");
  }
  rmSync(resolved, { recursive: true });
}

describe("pinned public gateway reference prices", () => {
  it("preserves provenance, exact SKU, raw conditions and independent component decisions", () => {
    expect(referenceCatalog.source.commit).toBe("f723eee74abf53adfb6d1a5ca7633f3823964315");
    expect(referenceCatalog.source.files.map(f => f.sha256)).toEqual(["9cfcf4cad356fc1cc9bacb0ca848e85b34a678fe7cef4ffd48597536f20568bc", "c361dd9787fccc832b97aab729dd8c383fcc3f3cdffdf37e724887ffce12d151"]);
    expect(catalogDigest).toBe(digest(referenceCatalog));
    const p = plan().decisions[0]!;
    expect(p).toMatchObject({ reason: "insert_published_reference", historical_applicability: "not_established", price: { model: "deepseek-chat", provider: "claude", connection_id: "test-gateway", requested_model_alias: false, source: "published", input_per_million: 0.28, cache_write_per_million: null, unsplit_per_million: null, effective_from: from } });
  });
  it("every eligible component is backed by its verbatim raw numeric field", () => {
    const fields = { input_per_million: "input_cost_per_token", output_per_million: "output_cost_per_token", cache_read_per_million: "cache_read_input_token_cost", cache_write_per_million: "cache_creation_input_token_cost", unsplit_per_million: "no_unsplit_source_field" };
    for (const e of referenceCatalog.entries) {
      for (const [component, sourceField] of Object.entries(fields)) {
        const decision = e.components[component as keyof typeof fields];
        if (decision.per_million !== null) {
          const raw = e.raw as Record<string, unknown>;
          expect(decision.reason).toBe("flat_catalog_component");
          expect(decision.condition_fields).toEqual([]);
          expect(decision.per_million).toBe(Number(raw[sourceField]) * 1000000);
          expect(e.definition_kind).not.toBe("alias");
        }
      }
    }
  });
  it("accounts for every observed group without guessing models, aliases, vendors or connections", () => {
    const rows = [observed({ model: null }), observed({ model_source: "configured" }), observed({ connection_id: null }), observed({ provider: "codex" }), observed({ model: "claude-opus-4-8" }), observed({ model: "DEEPSEEK-CHAT" }), observed({ model: "gpt-6" })];
    expect(plan(rows).decisions.map(d => d.reason)).toEqual(["unknown_actual_model", "unknown_actual_model", "unknown_route", "route_not_evidenced_for_catalog", "source_alias_not_actual_sku", "source_absent_or_sku_not_reviewed", "source_absent_or_sku_not_reviewed"]);
    expect(plan(rows).decisions.every(d => d.price === null)).toBe(true);
  });
  it("keeps explicit free cache write while skipping off-peak input/output/cache-read", () => {
    const p = plan([observed({ model: "deepseek-flash" })]).decisions[0]!;
    expect(p.price).toMatchObject({ input_per_million: null, output_per_million: null, cache_read_per_million: null, cache_write_per_million: 0, unsplit_per_million: null });
    expect(p.component_decisions!.input_per_million).toMatchObject({ reason: "unsupported_conditions", condition_fields: ["off_peak_pricing"] });
  });
  it("does not flatten long context, service tiers or cache TTL into flat rates", () => {
    expect(plan([observed({ model: "gpt-6.1-sol" })]).decisions[0]!.reason).toBe("no_unambiguous_components");
    const p = plan([observed({ model: "claude-3-haiku-20240307" })]).decisions[0]!;
    expect(p.price).toMatchObject({ input_per_million: 0.25, output_per_million: 1.25, cache_read_per_million: 0.03, cache_write_per_million: null });
    expect(p.component_decisions!.cache_write_per_million).toMatchObject({ reason: "unsupported_conditions", condition_fields: ["cache_creation_input_token_cost_above_1hr"] });
  });
  it("rejects backdating, unverified catalog mappings, ambiguous and oversized routes", () => {
    expect(() => plan([], { routes: [route({ effective_from: "2026-10-05T22:25:40.000Z" })] })).toThrow("historical");
    expect(() => plan([], { routes: [route({ effective_from: "2099-01-01T00:00:00.000Z" })] })).toThrow("future");
    expect(() => plan([], { routes: [route({ catalog_commit: "vendor-name-is-not-route-evidence" })] })).toThrow("catalog commit");
    expect(() => plan([], { routes: [route(), route()] })).toThrow("Ambiguous");
    expect(() => plan(Array.from({ length: 5001 }, () => observed()))).toThrow("5000");
  });
  it("keeps historical usage outside the retrieved/current reference interval", () => {
    const p = plan([observed({ first_at: "2025-01-01T00:00:00Z", last_at: "2025-01-02T00:00:00Z" })]).decisions[0]!;
    expect(p.price!.effective_from).toBe(from);
    expect(p.historical_applicability).toBe("not_established");
  });
  it("skips occupied configured/open/future intervals without closing any versions", () => {
    createLocalStore(); const { repo } = priceRepository(db!);
    const original = repo.setPrice("local", configured());
    expect(plan(undefined, { existing: repo.listPrices("local") }).decisions[0]!.reason).toBe("occupied_interval");
    const p = plan(undefined, { existing: repo.listPrices("local") });
    expect(applyReferencePlan(db!, p, target, "local")).toEqual({ inserted: 0, already_present: 0 });
    expect(repo.listPrices("local")).toEqual([original]);
    repo.closePrice("local", original.id, from);
    expect(plan(undefined, { existing: repo.listPrices("local") }).decisions[0]!.reason).toBe("insert_published_reference");
    repo.setPrice("local", configured({ effective_from: "2026-10-07T00:00:00.000Z" }));
    expect(plan(undefined, { existing: repo.listPrices("local") }).decisions[0]!.reason).toBe("occupied_interval");
  });
  it("applies unique published rows atomically and reimport changes neither prices nor revision", () => {
    createLocalStore(); const { repo } = priceRepository(db!);
    const p = plan([observed(), observed()]);
    expect(applyReferencePlan(db!, p, target, "local")).toEqual({ inserted: 1, already_present: 0 });
    const saved = repo.listPrices("local");
    const revision = db!.query("SELECT revision FROM multiremi_usage_price_revisions WHERE workspace_id='local'").get();
    expect(applyReferencePlan(db!, p, target, "local")).toEqual({ inserted: 0, already_present: 1 });
    expect(repo.listPrices("local")).toEqual(saved);
    expect(db!.query("SELECT revision FROM multiremi_usage_price_revisions WHERE workspace_id='local'").get()).toEqual(revision);
    expect(plan(undefined, { existing: saved }).decisions[0]!.reason).toBe("already_present");
  });
  it("rejects concurrent new configuration and edits under the workspace lock before any insert", () => {
    createLocalStore(); const { repo } = priceRepository(db!);
    const p = plan([observed(), observed({ model: "deepseek-reasoner" })]);
    repo.setPrice("local", configured({ model: "deepseek-reasoner" }));
    expect(() => applyReferencePlan(db!, p, target, "local")).toThrow("preconditions changed");
    expect(repo.listPrices("local")).toHaveLength(1);
    expect(repo.listPrices("local")[0]!.source).toBe("configured");
  });
  it("rejects malicious rates, intervals, aliases, workspace/target and unknown plan fields", () => {
    createLocalStore();
    for (const mutation of [
      (p: ReferencePlan) => { p.decisions[0]!.price!.input_per_million = 0; },
      (p: ReferencePlan) => { p.decisions[0]!.price!.requested_model_alias = true; },
      (p: ReferencePlan) => { p.decisions[0]!.price!.effective_from = "2020-01-01T00:00:00.000Z"; },
      (p: ReferencePlan) => { p.workspace_id = "another"; },
      (p: ReferencePlan) => { p.target = "postgres://another:5432/postgres"; },
      (p: ReferencePlan) => { Object.assign(p, { sneaky: true }); },
    ]) { const p = structuredClone(plan()); mutation(p); expect(() => applyReferencePlan(db!, p, target, "local")).toThrow(); }
    expect(priceRepository(db!).repo.listPrices("local")).toHaveLength(0);
  });
  it("redacts credentials and requires a concrete database target", () => {
    expect(databaseTarget("postgres://usage_test:usage_test@127.0.0.1:55486/postgres?application_name=secret")).toBe(target);
    expect(() => databaseTarget("postgres://127.0.0.1/")).toThrow();
  });
  it("uses existing report calculation: references never raise confirmed coverage or backdate history", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "reference-test", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "reference-test", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "dummy", workspaceId: "local", maxAttempts: 1 });
    store.claimTask(runtime.id); store.startTask(task.id);
    const unit = { unitId: "current", revision: 1, provider: "claude", model: "deepseek-chat", modelSource: "provider_reported" as const, connectionId: "test-gateway", scope: "request" as const, source: "provider_request" as const, accuracy: "exact" as const,
      inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 2000000, contextTokens: null, contextWindow: null, costAmount: null, costCurrency: null, occurredAt: from };
    store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "test", revision: 1, complete: true, units: [unit, { ...unit, unitId: "historical", occurredAt: "2026-01-01T00:00:00.000Z" }] });
    const observations = observeSkus(db!, "local");
    expect(observations[0]!.units).toBe(2);
    applyReferencePlan(db!, plan(observations), target, "local");
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 4000000, priced_tokens: 0, unpriced_tokens: 4000000, known_cost_by_currency: {}, reference_cost_by_currency: { USD: 0.7 }, complete: false });
    expect(report.coverage.token_ratio).toBe(0);
  });
  it.skipIf(referenceAdminUrl === undefined)("serializes with a real PostgreSQL configured writer, rejects stale review and reimports unchanged", async () => withReferenceDatabase(async url => {
    const ownTarget = databaseTarget(url);
    const pg = new PostgresSyncDatabase(url);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      pg.exec("CREATE TABLE multiremi_workspaces(id TEXT PRIMARY KEY,updated_at TEXT); CREATE TABLE multiremi_tasks(id TEXT PRIMARY KEY); CREATE TABLE multiremi_schema_migrations(id TEXT PRIMARY KEY,applied_at TEXT)");
      pg.run("INSERT INTO multiremi_workspaces(id,updated_at) VALUES('local',?)", [from]);
      ensureUsageAccountingSchema(pg);
      const p = plan(undefined, { target: ownTarget });
      const scriptUrl = new URL("../../../scripts/import-usage-reference-prices.ts", import.meta.url).pathname;
      const pgUrl = new URL("../../../packages/server/src/store/db/postgres.ts", import.meta.url).pathname;
      const code = `import { PostgresSyncDatabase } from ${JSON.stringify(pgUrl)};
        import { priceRepository } from ${JSON.stringify(scriptUrl)};
        const db = new PostgresSyncDatabase(process.env.MULTIREMI_TEST_REFERENCE_OWN_URL!);
        try {
          db.transaction(() => { const { ctx, repo } = priceRepository(db); ctx.lockWorkspaceRuntimeLifecycle('local');
            repo.setPrice('local', ${JSON.stringify(configured())});
            process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
          })();
        } finally { db.close(); }`;
      child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env, MULTIREMI_TEST_REFERENCE_OWN_URL: url }, stdout: "pipe", stderr: "pipe" });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("locked");
      expect(() => applyReferencePlan(pg, p, ownTarget, "local")).toThrow("preconditions changed");
      expect(await child.exited).toBe(0);
      const { repo } = priceRepository(pg);
      const saved = repo.listPrices("local");
      expect(saved).toHaveLength(1);
      expect(saved[0]!.source).toBe("configured");
      expect(saved[0]!.effective_to).toBeNull();
      // A separate exact SKU remains eligible; existing configured row survives both imports.
      const next = plan([observed({ model: "deepseek-reasoner" })], { target: ownTarget, existing: saved });
      expect(applyReferencePlan(pg, next, ownTarget, "local")).toEqual({ inserted: 1, already_present: 0 });
      expect(applyReferencePlan(pg, next, ownTarget, "local")).toEqual({ inserted: 0, already_present: 1 });
      expect(repo.listPrices("local").find(r => r.id === saved[0]!.id)).toEqual(saved[0]);
    } finally {
      if (child) { child.kill(); await child.exited; }
      pg.close();
    }
  }), 20000);
  it.skipIf(referenceAdminUrl === undefined)("CLI plans read-only and applies only reviewed published rows to an isolated database", async () => withReferenceDatabase(async url => {
    const dir = mkdtempSync(join(tmpdir(), "reference-cli-"));
    let own: PostgresSyncDatabase | undefined;
    try {
      own = new PostgresSyncDatabase(url);
      own.exec("CREATE TABLE multiremi_workspaces(id TEXT PRIMARY KEY,updated_at TEXT); CREATE TABLE multiremi_tasks(id TEXT PRIMARY KEY); CREATE TABLE multiremi_schema_migrations(id TEXT PRIMARY KEY,applied_at TEXT)");
      own.run("INSERT INTO multiremi_workspaces(id,updated_at) VALUES('local',?)", [from]);
      ensureUsageAccountingSchema(own);
      own.exec("INSERT INTO multiremi_tasks(id) VALUES('dummy'); INSERT INTO multiremi_usage_runs(task_id,run_id,revision,complete) VALUES('dummy','test',1,1)");
      own.run(`INSERT INTO multiremi_usage_units(task_id,run_id,unit_id,revision,workspace_id,agent_id,provider,model,model_source,connection_id,scope,source,accuracy,occurred_at)
        VALUES('dummy','test','request',1,'local','dummy','claude','deepseek-chat','provider_reported','test-gateway','request','provider_request','exact',?)`, [from]);
      const routes = join(dir, "routes.json"), output = join(dir, "plan.json");
      writeFileSync(routes, JSON.stringify([route()]));
      const script = new URL("../../../scripts/import-usage-reference-prices.ts", import.meta.url).pathname;
      const common = [process.execPath, "run", script, "--workspace=local", `--target=${databaseTarget(url)}`];
      async function invoke(extra: string[]) {
        const child = Bun.spawn([...common, ...extra], { env: { ...process.env, MULTIREMI_DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const password = decodeURIComponent(new URL(url).password);
        if ([stdout, stderr].some(text => text.includes(url) || (password && text.includes(password)))) throw new Error("CLI exposed database connection credentials");
        if (code) throw new Error(`Reference CLI exited ${code}`);
        return JSON.parse(stdout);
      }
      const dry = await invoke([`--routes=${routes}`, `--out=${output}`]);
      expect(dry.mode).toBe("read-only");
      expect(priceRepository(own).repo.listPrices("local")).toHaveLength(0);
      const reviewed = JSON.parse(readFileSync(output, "utf8")) as ReferencePlan;
      expect(reviewed.decisions[0]!.reason).toBe("insert_published_reference");
      expect(await invoke([`--apply-plan=${output}`, "--execute"])).toEqual({ inserted: 1, already_present: 0 });
      expect(await invoke([`--apply-plan=${output}`, "--execute"])).toEqual({ inserted: 0, already_present: 1 });
      expect(priceRepository(own).repo.listPrices("local")[0]!.source).toBe("published");
    } finally {
      own?.close();
      removeReferenceDirectory(dir);
    }
  }), 20000);
});
