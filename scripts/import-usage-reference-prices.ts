/** Offline, reviewed reference-price maintenance. Never connects to model providers. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import type { SetUsagePriceInput, UsagePrice } from "../packages/contracts/src/usage-accounting.js";
import { StoreContext } from "../packages/server/src/store/context.js";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { UsageAccountingRepo } from "../packages/server/src/store/repos/usage-accounting-repo.js";
import catalogData from "../packages/server/src/store/data/usage-reference-prices.json";

export const RATE_KEYS = ["input_per_million", "output_per_million", "cache_read_per_million", "cache_write_per_million", "unsplit_per_million"] as const;
type RateKey = typeof RATE_KEYS[number];
export const referenceCatalog = catalogData;
const LIMIT = 5000;
const FILE_LIMIT = 16 * 1024 * 1024;
export interface ObservedSku {
  provider: string; model: string | null; model_source: string; connection_id: string | null;
  units: number; first_at: string | null; last_at: string | null;
}
/** Operator-reviewed route evidence, without credentials or endpoint secrets. */
export interface ReferenceRoute {
  provider: string; connection_id: string; evidence: string;
  catalog_commit: string; effective_from: string; effective_to: string | null;
}
interface Decision {
  observed: ObservedSku; reason: string; price: SetUsagePriceInput | null;
  component_decisions: Record<RateKey, unknown> | null;
  historical_applicability: "not_established";
}
export interface ReferencePlan {
  version: 1; target: string; workspace_id: string; catalog_sha256: string; created_at: string;
  routes: ReferenceRoute[]; observed: ObservedSku[]; existing: UsagePrice[]; decisions: Decision[];
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
export const catalogDigest = digest(referenceCatalog);
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Expected canonical ISO timestamp");
  return value;
}
function textField(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 2000) throw new Error(`Invalid ${field}`);
}
function validateRoutes(routes: ReferenceRoute[], now: string): void {
  if (!Array.isArray(routes) || routes.length > LIMIT) throw new Error("Invalid/bounded routes required");
  const seen = new Set<string>();
  for (const r of routes) {
    textField(r.provider, "provider"); textField(r.connection_id, "connection_id"); textField(r.evidence, "route evidence");
    if (r.catalog_commit !== referenceCatalog.source.commit) throw new Error("Route must explicitly identify this gateway catalog commit");
    timestamp(r.effective_from);
    if (r.effective_from < referenceCatalog.applicability.earliest_effective_from || r.effective_from > now) throw new Error("No historical or future applicability assertion");
    if (r.effective_to !== null && timestamp(r.effective_to) <= r.effective_from) throw new Error("Invalid route interval");
    const key = JSON.stringify([r.provider, r.connection_id]);
    if (seen.has(key)) throw new Error("Ambiguous route evidence");
    seen.add(key);
  }
}
const sameKey = (p: UsagePrice, v: SetUsagePriceInput) => p.provider === v.provider && p.model === v.model && p.connection_id === v.connection_id;
function priceInput(p: UsagePrice): SetUsagePriceInput {
  return { provider: p.provider, model: p.model, connection_id: p.connection_id, requested_model_alias: p.requested_model_alias,
    currency: p.currency, source: p.source, source_url: p.source_url, effective_from: p.effective_from, effective_to: p.effective_to,
    ...Object.fromEntries(RATE_KEYS.map(k => [k, p[k]])) } as SetUsagePriceInput;
}
const samePrice = (p: UsagePrice, v: SetUsagePriceInput) => digest(priceInput(p)) === digest(v);
export function buildReferencePlan(input: { target: string; workspace_id: string; routes: ReferenceRoute[]; observed: ObservedSku[]; existing: UsagePrice[]; now?: string }): ReferencePlan {
  const now = timestamp(input.now ?? new Date().toISOString());
  textField(input.target, "target"); textField(input.workspace_id, "workspace");
  validateRoutes(input.routes, now);
  if (input.observed.length > LIMIT || input.existing.length > LIMIT) throw new Error("Scope exceeds 5000 rows; narrow workspace or review manually");
  const decisions: Decision[] = input.observed.map(observed => {
    const entry = referenceCatalog.entries.find(e => e.original_sku === observed.model);
    const result = (reason: string, price: SetUsagePriceInput | null = null): Decision => ({ observed, reason, price,
      component_decisions: entry?.components ?? null, historical_applicability: "not_established" });
    if (!observed.model || observed.model_source !== "provider_reported") return result("unknown_actual_model");
    if (!observed.connection_id) return result("unknown_route");
    const route = input.routes.find(r => r.provider === observed.provider && r.connection_id === observed.connection_id);
    if (!route) return result("route_not_evidenced_for_catalog");
    if (!entry || entry.raw === null) return result("source_absent_or_sku_not_reviewed");
    if (entry.definition_kind === "alias") return result("source_alias_not_actual_sku");
    if (!RATE_KEYS.some(k => entry.components[k].per_million !== null)) return result("no_unambiguous_components");
    const price: SetUsagePriceInput = { provider: observed.provider, model: observed.model, connection_id: observed.connection_id,
      requested_model_alias: false, currency: "USD", source: "published", source_url: referenceCatalog.source.files[0]!.url,
      effective_from: route.effective_from, effective_to: route.effective_to,
      ...Object.fromEntries(RATE_KEYS.map(k => [k, entry.components[k].per_million])) } as SetUsagePriceInput;
    if (input.existing.some(p => sameKey(p, price) && samePrice(p, price))) return result("already_present", price);
    // Includes configured versions and requested aliases. Never let setPrice auto-close them.
    if (input.existing.some(p => sameKey(p, price) && p.effective_from < (price.effective_to ?? "9999") && (p.effective_to === null || p.effective_to > price.effective_from))) return result("occupied_interval");
    return result("insert_published_reference", price);
  });
  return { version: 1, target: input.target, workspace_id: input.workspace_id, catalog_sha256: catalogDigest,
    created_at: now, routes: input.routes, observed: input.observed, existing: input.existing, decisions };
}

export function observeSkus(db: SqlDatabase, workspace: string): ObservedSku[] {
  return db.query(`SELECT provider,model,model_source,connection_id,COUNT(*) AS units,MIN(occurred_at) AS first_at,MAX(occurred_at) AS last_at
    FROM multiremi_usage_units WHERE workspace_id=? GROUP BY provider,model,model_source,connection_id
    ORDER BY provider,model,model_source,connection_id LIMIT 5001`).all(workspace).map(r => ({ ...r, units: Number(r.units) })) as ObservedSku[];
}
export function priceRepository(db: SqlDatabase): { ctx: StoreContext; repo: UsageAccountingRepo } {
  // Pricing uses only db and workspace lifecycle locks; no facade/schema/startup side effects.
  const ctx = new StoreContext(db, () => { throw new Error("Importer cannot access other store domains"); });
  return { ctx, repo: new UsageAccountingRepo(ctx) };
}
function boundedPrices(db: SqlDatabase, workspace: string): UsagePrice[] {
  const rows = db.query("SELECT * FROM multiremi_usage_prices WHERE workspace_id=? ORDER BY provider,model,connection_id,effective_from DESC LIMIT 5001").all(workspace);
  if (rows.length > LIMIT) throw new Error("Scope exceeds 5000 prices; review manually");
  return rows.map(r => ({ ...r, requested_model_alias: Number(r.requested_model_alias) === 1 })) as UsagePrice[];
}
export function applyReferencePlan(db: SqlDatabase, plan: ReferencePlan, target: string, workspace: string): { inserted: number; already_present: number } {
  if (plan.version !== 1 || plan.target !== target || plan.workspace_id !== workspace || plan.catalog_sha256 !== catalogDigest) throw new Error("Plan target/workspace/catalog mismatch");
  timestamp(plan.created_at);
  if (plan.created_at > new Date().toISOString()) throw new Error("Plan is from the future");
  // Rebuild from pinned data, rather than trusting arbitrary prices in edited plan JSON.
  const reviewed = buildReferencePlan({ target, workspace_id: workspace, routes: plan.routes, observed: plan.observed, existing: plan.existing, now: plan.created_at });
  if (digest(reviewed) !== digest(plan)) throw new Error("Plan content does not match deterministic catalog review");
  const { ctx, repo } = priceRepository(db);
  return db.transaction(() => {
    if (!db.query("SELECT id FROM multiremi_workspaces WHERE id=?").get(workspace)) throw new Error("Workspace not found");
    ctx.lockWorkspaceRuntimeLifecycle(workspace);
    const current = boundedPrices(db, workspace);
    const candidates = plan.decisions.filter(d => d.reason === "insert_published_reference").map(d => d.price!);
    // Extra exact rows from a prior application are allowed; any edit/closure/new configuration rejects the whole transaction.
    if (plan.existing.some(p => !current.some(c => digest(c) === digest(p))) || current.some(c => !plan.existing.some(p => digest(c) === digest(p)) && !candidates.some(p => samePrice(c, p)))) throw new Error("Price preconditions changed; regenerate and review plan");
    const unique = new Map(candidates.map(p => [digest(p), p]));
    let inserted = 0, already_present = 0;
    for (const p of unique.values()) {
      if (current.some(c => samePrice(c, p))) { already_present++; continue; }
      // Checked again under the same lock used by setPrice/closePrice, including earlier open versions.
      if (current.some(c => sameKey(c, p) && c.effective_from < (p.effective_to ?? "9999") && (c.effective_to === null || c.effective_to > p.effective_from))) throw new Error("Occupied interval; regenerate plan");
      current.push(repo.setPrice(workspace, p)); inserted++;
    }
    return { inserted, already_present };
  })();
}
export function databaseTarget(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(u.protocol) || !u.hostname || !u.pathname || u.pathname === "/") throw new Error("Explicit PostgreSQL URL with database required");
  // Target is safe to review; neither URL credentials nor query parameters enter plans/output.
  return `postgres://${u.hostname}:${u.port || "5432"}${u.pathname}`;
}
function readJson(path: string): unknown {
  if (statSync(path).size > FILE_LIMIT) throw new Error("Review file exceeds 16 MiB");
  return JSON.parse(readFileSync(path, "utf8"));
}
export async function mainImportReferencePrices(args = process.argv.slice(2)): Promise<void> {
  const opts = new Map<string, string>(); let execute = false;
  for (const arg of args) {
    if (arg === "--help") { process.stdout.write("--workspace=<id> --target=postgres://host:port/database [--routes=<evidence.json>] --out=<plan.json>\n--workspace=<id> --target=<same-target> --apply-plan=<reviewed-plan.json> --execute\nRequires explicit MULTIREMI_DATABASE_URL; default is a read-only plan. No startup or provider access.\n"); return; }
    if (arg === "--execute") { execute = true; continue; }
    const match = /^--(workspace|target|routes|out|apply-plan)=(.+)$/.exec(arg);
    if (!match || opts.has(match[1]!)) throw new Error("Unknown or duplicate argument");
    opts.set(match[1]!, match[2]!);
  }
  const workspace = opts.get("workspace"), target = opts.get("target"), url = process.env.MULTIREMI_DATABASE_URL;
  if (!workspace || !target || !url || databaseTarget(url) !== target) throw new Error("Explicit matching database target and workspace required");
  if (execute !== opts.has("apply-plan") || (execute && (opts.has("routes") || opts.has("out"))) || (!execute && !opts.has("out"))) throw new Error("Plan needs --out; apply needs --apply-plan and --execute only");
  const db = new PostgresSyncDatabase(url);
  try {
    // Explicitly bind maintenance to the app's public schema regardless of role/URL search_path.
    db.exec("SET search_path TO public");
    if (execute) {
      const plan = readJson(opts.get("apply-plan")!) as ReferencePlan;
      process.stdout.write(`${JSON.stringify(applyReferencePlan(db, plan, target, workspace))}\n`);
    } else {
      const routes = opts.has("routes") ? readJson(opts.get("routes")!) as ReferenceRoute[] : [];
      const plan = db.transaction(() => {
        db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        if (!db.query("SELECT id FROM multiremi_workspaces WHERE id=?").get(workspace)) throw new Error("Workspace not found");
        return buildReferencePlan({ target, workspace_id: workspace, routes, observed: observeSkus(db, workspace), existing: boundedPrices(db, workspace) });
      })();
      const output = `${JSON.stringify(plan, null, 2)}\n`;
      if (Buffer.byteLength(output, "utf8") > FILE_LIMIT) throw new Error("Generated review plan exceeds 16 MiB; narrow scope or review manually");
      writeFileSync(opts.get("out")!, output, { mode: 0o600, flag: "wx" });
      process.stdout.write(`${JSON.stringify({ mode: "read-only", groups: plan.observed.length, decisions: plan.decisions.map(d => ({ model: d.observed.model, reason: d.reason })), catalog_sha256: catalogDigest })}\n`);
    }
  } finally { db.close(); }
}
if (import.meta.main) await mainImportReferencePrices();
