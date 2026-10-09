import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  PlatformOperationsRepo,
  PlatformOperationConflictError,
  isTerminalPlatformOperationStatus,
} from "@multiremi/store/repos/platform-operations-repo.js";
import type { MultiremiPlatformOperationStatus } from "@multiremi/contracts/types.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";

const repoRoot = resolve(import.meta.dir, "../..");
const readme = readFileSync(resolve(repoRoot, "deploy/README.md"), "utf8");
const scriptMatch = readme.match(/remi platform operation list[^\n]*\| python3 -c "([\s\S]*?)\n  "/u);
if (!scriptMatch) throw new Error("README operation pre-check script is missing");
const pythonScript = scriptMatch[1]!.replace(/^  /gmu, "").replaceAll('\\"', '"');
const authWrite = "UPDATE multiremi_access_tokens SET last_used_at = ? WHERE id = ?";
const scenarios = ["expired-drain", "missing-state", "active-operation"] as const;
type Scenario = typeof scenarios[number] | "missing-local";
interface Write { sql: string; changes: number }

const contractSource = ts.createSourceFile("types.ts",
  readFileSync(resolve(repoRoot, "packages/contracts/src/types.ts"), "utf8"),
  ts.ScriptTarget.Latest, true);
const statusDeclaration = contractSource.statements.find((node): node is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(node) && node.name.text === "MultiremiPlatformOperationStatus");
if (!statusDeclaration || !ts.isUnionTypeNode(statusDeclaration.type)) {
  throw new Error("Platform operation status contract must be a union");
}
const contractStatuses = statusDeclaration.type.types.map((node) => {
  if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) {
    throw new Error("Platform operation statuses must be string literals");
  }
  return node.literal.text as MultiremiPlatformOperationStatus;
});
const terminalStatuses = contractStatuses.filter(isTerminalPlatformOperationStatus);

// Audit execution, including prepared statement get/all/run/values and exec.
// Record attempted writes even when ON CONFLICT makes them affect zero rows.
// Bind parameters (including credential material) never enter the audit log.
function auditedDatabase(raw: Database, audit: { recording: boolean; writes: Write[] }): SqlDatabase {
  const record = (sql: string, result: unknown): void => {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (!audit.recording || /^(SELECT|EXPLAIN)\b/iu.test(normalized)) return;
    const changes = result && typeof result === "object" && "changes" in result
      ? Number(result.changes)
      : Number((raw.query("SELECT changes() AS n").get() as { n: number }).n);
    audit.writes.push({ sql: normalized, changes });
  };
  const statement = (sql: string, prepared: SqlStatement): SqlStatement => new Proxy(prepared, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          record(sql, result);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(raw, {
    get(target, property) {
      if (property === "query" || property === "prepare") {
        return (sql: string) => statement(sql, target[property](sql) as unknown as SqlStatement);
      }
      if (property === "run" || property === "exec") {
        return (sql: string, ...args: unknown[]) => {
          const result = Reflect.apply(target[property], target, [sql, ...args]);
          record(sql, result);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as SqlDatabase;
}

async function fixture(scenario: Scenario) {
  const raw = openSqliteDatabase(":memory:");
  const audit = { recording: false, writes: [] as Write[] };
  const store = new MultiremiStore(auditedDatabase(raw, audit));
  store.ensureLocalWorkspace();
  const credential = await store.createAccessToken({ name: "MUL-464 local HTTP audit", type: "pat" });
  let activeId: string | null = null;
  if (scenario === "expired-drain" || scenario === "active-operation") {
    store.getPlatformState();
    store.getPlatformMaintenance();
    const operation = store.createPlatformOperation({ kind: "restart" }, "local");
    if (scenario === "expired-drain") {
      store.reportPlatformOperation(operation.id, { status: "succeeded" });
      const finishedAt = new Date(Date.now() - 12 * 60_000).toISOString();
      raw.run("UPDATE multiremi_platform_operations SET finished_at = ?, updated_at = ? WHERE id = ?",
        [finishedAt, finishedAt, operation.id]);
    } else {
      store.reportPlatformOperation(operation.id, { status: "rolling_back" });
      activeId = operation.id;
    }
    store.beginPlatformDrain({ operationId: operation.id, reason: "local audit fixture" });
    if (scenario === "expired-drain") {
      raw.run("UPDATE multiremi_platform_maintenance SET expires_at = ? WHERE id = 'platform'",
        [new Date(Date.now() - 60_000).toISOString()]);
    }
  } else {
    raw.run("DELETE FROM multiremi_platform_state");
    raw.run("DELETE FROM multiremi_platform_maintenance");
  }
  if (scenario === "missing-local") {
    raw.run("DELETE FROM multiremi_workspaces WHERE id = 'local'");
  }
  const snapshot = () => ({
    maintenance: raw.query("SELECT * FROM multiremi_platform_maintenance ORDER BY id").all(),
    state: raw.query("SELECT * FROM multiremi_platform_state ORDER BY id").all(),
  });
  const app = createMultiremiApp({ store, authToken: randomUUID() });
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return app.fetch(request);
    },
  });
  const before = snapshot();
  audit.recording = true;
  return {
    raw, audit, store, before, snapshot, activeId, requests, server,
    async request(path: string) {
      const response = await fetch(new URL(path, server.url), {
        headers: { Authorization: `Bearer ${credential.token}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    },
    async cli() {
      const child = Bun.spawn([process.execPath, "run", "apps/remi/main.ts",
        "platform", "operation", "list", "--output", "json", "--limit", "100",
        "--server", server.url.origin], {
        cwd: repoRoot,
        env: { ...process.env, MULTIREMI_TOKEN: credential.token },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout);
    },
    close() {
      audit.recording = false;
      server.stop(true);
      raw.close();
    },
  };
}

function checkOperations(body: unknown) {
  return spawnSync("python3", ["-c", pythonScript], {
    input: JSON.stringify(body), encoding: "utf8",
  });
}

function assertOnlyAuthWrites(writes: Write[], writeCount = 1) {
  expect(writes, "only last_used_at authentication bookkeeping may be written").toEqual(
    Array.from({ length: writeCount }, () => ({ sql: authWrite, changes: 1 })),
  );
}

function repoFixture() {
  const raw = openSqliteDatabase(":memory:");
  const audit = { recording: false, writes: [] as Write[] };
  const db = auditedDatabase(raw, audit);
  new MultiremiStore(db);
  return {
    raw, audit, repo: new PlatformOperationsRepo(db),
    row(id: string) {
      return raw.query("SELECT * FROM multiremi_platform_operations WHERE id = ?").get(id) as
        Record<string, unknown>;
    },
    close() { raw.close(); },
  };
}

describe("MUL-464 serialized platform-operation invariants", () => {
  test("create conflicts while an operation holds the unique active slot", () => {
    const f = repoFixture();
    try {
      const active = f.repo.create({ kind: "restart" }, "local");
      expect(() => f.repo.create({ kind: "update" }, "local")).toThrow(PlatformOperationConflictError);
      expect(f.row(active.id).active_slot).toBe(1);
      const indexes = f.raw.query("PRAGMA index_list(multiremi_platform_operations)").all();
      expect(indexes).toContainEqual(expect.objectContaining({
        name: "idx_multiremi_platform_operations_active", unique: 1,
      }));
      expect(f.repo.list(100)).toHaveLength(1);
    } finally { f.close(); }
  });

  test.each(contractStatuses)("report maps contract status %s to its terminal or active slot", status => {
      const f = repoFixture();
      try {
        const operation = f.repo.create({ kind: "restart" }, "local");
        expect(f.repo.report(operation.id, { status })?.status, status).toBe(status);
        const row = f.row(operation.id);
        expect(row.active_slot, status).toBe(isTerminalPlatformOperationStatus(status) ? null : 1);
        expect(row.finished_at, status).toBe(isTerminalPlatformOperationStatus(status) ? row.updated_at : null);
      } finally { f.close(); }
  });

  test("a terminal operation ignores subsequent reports for every contract status", () => {
    for (const terminal of terminalStatuses) {
      const f = repoFixture();
      try {
        const operation = f.repo.create({ kind: "restart" }, "local");
        const completed = f.repo.report(operation.id, { status: terminal });
        const before = f.row(operation.id);
        f.audit.recording = true;
        for (const status of contractStatuses) {
          expect(f.repo.report(operation.id, { status, output: "must not be written" }), `${terminal} -> ${status}`)
            .toEqual(completed);
          expect(f.row(operation.id), `${terminal} -> ${status}`).toEqual(before);
        }
        expect(f.audit.writes, terminal).toEqual([]);
        expect(f.row(operation.id).active_slot, terminal).toBeNull();
      } finally { f.close(); }
    }
  });

  test("cancelling a queued operation releases the slot and is irreversible", () => {
    const f = repoFixture();
    try {
      const operation = f.repo.create({ kind: "restart" }, "local");
      expect(f.repo.requestCancel(operation.id).status).toBe("cancelled");
      expect(f.row(operation.id).active_slot).toBeNull();
      expect(f.row(operation.id).finished_at).toBe(f.row(operation.id).updated_at);
      const before = f.row(operation.id);
      f.audit.recording = true;
      expect(f.repo.report(operation.id, { status: "queued" })?.status).toBe("cancelled");
      expect(f.row(operation.id)).toEqual(before);
      expect(f.audit.writes).toEqual([]);
    } finally { f.close(); }
  });

  test("claim changes queued to preparing without releasing the slot", () => {
    const f = repoFixture();
    try {
      const operation = f.repo.create({ kind: "restart" }, "local");
      expect(f.repo.claim()).toMatchObject({ id: operation.id, status: "preparing" });
      expect(f.row(operation.id).active_slot).toBe(1);
      expect(() => f.repo.create({ kind: "restart" }, "local")).toThrow(PlatformOperationConflictError);
    } finally { f.close(); }
  });
});

describe("MUL-464 operation pre-check over real loopback HTTP and SQLite", () => {
  test("missing local workspace triggers business INSERT and UPDATE during authentication", async () => {
    const f = await fixture("missing-local");
    try {
      expect(f.raw.query("SELECT id FROM multiremi_workspaces WHERE id = 'local'").get()).toBeNull();
      expect(f.raw.query("SELECT id FROM multiremi_workspace_members WHERE workspace_id = 'local'").get())
        .not.toBeNull();
      await f.request("/api/multiremi/platform/operations?limit=100");
      expect(f.audit.writes).toHaveLength(3);
      expect(f.audit.writes[0]).toEqual({ sql: authWrite, changes: 1 });
      expect(f.audit.writes[1]).toMatchObject({ changes: 1 });
      expect(f.audit.writes[1]!.sql).toMatch(/^INSERT INTO multiremi_workspaces /u);
      expect(f.audit.writes[2]).toEqual({
        sql: "UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?",
        changes: 1,
      });
      expect(f.raw.query("SELECT id, issue_prefix FROM multiremi_workspaces WHERE id = 'local'").get())
        .toEqual({ id: "local", issue_prefix: "MUL" });
      expect(f.snapshot()).toEqual(f.before);
      console.info(JSON.stringify({ endpoint: "operations", scenario: "missing-local", writes: f.audit.writes }));
    } finally { f.close(); }
  });

  for (const scenario of scenarios) {
    test(`operations leaves all platform state unchanged: ${scenario}`, async () => {
      const f = await fixture(scenario);
      try {
        const body = await f.request("/api/multiremi/platform/operations?limit=100");
        assertOnlyAuthWrites(f.audit.writes);
        expect(f.snapshot(), "maintenance and platform_state must match field for field").toEqual(f.before);
        expect(f.requests).toEqual(["GET /api/multiremi/platform/operations"]);
        const gate = checkOperations(body);
        if (scenario === "active-operation") {
          expect(gate.stdout.trim()).toBe(`activeOperation: ${f.activeId} restart rolling_back`);
          expect(gate.status).toBe(1);
          expect(body.operations).toHaveLength(1);
          expect(f.raw.query("SELECT active_slot FROM multiremi_platform_operations WHERE id = ?")
            .get(f.activeId)).toEqual({ active_slot: 1 });
        } else {
          expect(gate.stdout.trim()).toBe("activeOperation: none");
          expect(gate.status, gate.stderr).toBe(0);
        }
        console.info(JSON.stringify({ endpoint: "operations", scenario, writes: f.audit.writes }));
        f.audit.writes.length = 0;
        await f.request("/api/multiremi/platform/operations?limit=100");
        assertOnlyAuthWrites(f.audit.writes, 0);
        expect(f.snapshot()).toEqual(f.before);
      } finally { f.close(); }
    });

    test(`status control executes maintenance writes: ${scenario}`, async () => {
      const f = await fixture(scenario);
      try {
        await f.request("/api/multiremi/platform/status");
        expect(f.audit.writes[0]).toEqual({ sql: authWrite, changes: 1 });
        const stateWrites = f.audit.writes.filter((write) => write.sql.includes("multiremi_platform_state"));
        const maintenanceWrites = f.audit.writes.filter((write) => write.sql.includes("multiremi_platform_maintenance"));
        expect(stateWrites.map((write) => write.changes)).toEqual(scenario === "missing-state" ? [1] : []);
        expect(maintenanceWrites.map((write) => write.changes)).toEqual(
          scenario === "expired-drain" ? [0, 1] : [scenario === "missing-state" ? 1 : 0],
        );
        expect(f.audit.writes).toHaveLength(scenario === "active-operation" ? 2 : 3);
        if (scenario === "active-operation") {
          expect(f.snapshot()).toEqual(f.before);
        } else {
          expect(f.snapshot().maintenance).not.toEqual(f.before.maintenance);
          expect(f.snapshot().maintenance[0]).toMatchObject({ mode: "normal", operation_id: null, expires_at: null });
        }
        console.info(JSON.stringify({ endpoint: "status", scenario, writes: f.audit.writes }));
      } finally { f.close(); }
    });
  }

  test("the repository CLI produces the payload consumed by the literal README Python", async () => {
    for (const scenario of ["missing-state", "active-operation"] as const) {
      const f = await fixture(scenario);
      try {
        const body = await f.cli();
        // The CLI negotiates capabilities first; MUL-474 throttles the second
        // request's last_used_at stamp within the same minute.
        expect(f.requests).toEqual(["GET /api/cli/capabilities", "GET /api/multiremi/platform/operations"]);
        assertOnlyAuthWrites(f.audit.writes);
        expect(f.snapshot()).toEqual(f.before);
        const gate = checkOperations(body);
        expect(gate.status, gate.stderr).toBe(scenario === "missing-state" ? 0 : 1);
        expect(gate.stdout.trim()).toBe(scenario === "missing-state"
          ? "activeOperation: none" : `activeOperation: ${f.activeId} restart rolling_back`);
      } finally { f.close(); }
    }
  });

  const histories = [
    { name: "permit an idle window", minutesAgo: 12, withActive: false, missingFinishedAt: false },
    { name: "plus the latest active operation stop", minutesAgo: 12, withActive: true, missingFinishedAt: false },
    { name: "finished 5 minutes ago stop", minutesAgo: 5, withActive: false, missingFinishedAt: false },
    { name: "with null finishedAt and updatedAt 5 minutes ago stop", minutesAgo: 5, withActive: false, missingFinishedAt: true },
  ];
  for (const history of histories) {
    test(`150 terminal operations via CLI ${history.name}`, async () => {
      const f = await fixture("missing-state");
      try {
        f.audit.recording = false;
        const lastFinishedAt = new Date(Date.now() - history.minutesAgo * 60_000).toISOString();
        for (let index = 0; index < 150; index++) {
          const operation = f.store.createPlatformOperation({ kind: "restart" }, "local");
          f.store.reportPlatformOperation(operation.id, { status: terminalStatuses[index % terminalStatuses.length]! });
          // Historical times isolate the wait gate from fixture creation time.
          const createdAt = new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString();
          const finishedAt = index === 149 ? lastFinishedAt : createdAt;
          f.raw.run("UPDATE multiremi_platform_operations SET created_at = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            [createdAt, index === 149 && history.missingFinishedAt ? null : finishedAt, finishedAt, operation.id]);
        }
        const active = history.withActive ? f.store.createPlatformOperation({ kind: "restart" }, "local") : null;
        if (active) f.store.reportPlatformOperation(active.id, { status: "rolling_back" });
        expect(f.raw.query("SELECT COUNT(*) AS n FROM multiremi_platform_operations").get())
          .toEqual({ n: history.withActive ? 151 : 150 });
        const before = f.snapshot();
        f.audit.writes.length = 0;
        f.audit.recording = true;
        const body = await f.cli();
        expect(body.operations).toHaveLength(100);
        if (active) expect(body.operations[0]).toMatchObject({ id: active.id, status: "rolling_back" });
        assertOnlyAuthWrites(f.audit.writes);
        expect(f.snapshot()).toEqual(before);
        const gate = checkOperations(body);
        const waiting = history.minutesAgo < 11;
        expect(gate.status, gate.stderr).toBe(history.withActive || waiting ? 1 : 0);
        const waitUntil = new Date(Date.parse(lastFinishedAt) + 11 * 60_000).toISOString();
        expect(gate.stdout.trim()).toBe(active
          ? `activeOperation: ${active.id} restart rolling_back`
          : waiting ? `STOP: last operation finished at ${lastFinishedAt}; wait until ${waitUntil}`
          : "activeOperation: none");
      } finally { f.close(); }
    });
  }

  test("the pre-check refuses non-terminal, unknown and malformed responses", () => {
    const operation = (status: string) => ({ id: "pop_local", kind: "restart", status,
      finishedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    for (const status of ["queued", "preparing", "pulling", "draining", "switching",
      "restarting", "verifying", "rolling_back", "future_status"]) {
      const gate = checkOperations({ operations: [operation("succeeded"), operation(status)] });
      expect(gate.status, status).toBe(1);
      expect(gate.stdout.trim()).toBe(`activeOperation: pop_local restart ${status}`);
    }
    const terminalHistory = ["succeeded", "failed", "cancelled", "rolled_back"].map(operation);
    expect(checkOperations({ operations: terminalHistory }).status).toBe(0);
    for (const body of [{}, { operations: null }, { operations: [{}] }]) {
      const gate = checkOperations(body);
      expect(gate.status).not.toBe(0);
      expect(gate.stdout).not.toContain("activeOperation: none");
    }
  });

  test("the wait gate uses the latest completion across the page and compares in UTC", () => {
    const old = new Date(Date.now() - 12 * 60_000).toISOString();
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const operation = (finishedAt: string | null, updatedAt: string | null = null) =>
      ({ id: "pop_local", kind: "restart", status: "failed", finishedAt, updatedAt });
    const gate = checkOperations({ operations: [operation(old), operation(recent)] });
    expect(gate.status).toBe(1);
    expect(gate.stdout).toContain(`STOP: last operation finished at ${recent}; wait until `);
    const offset = new Date(Date.parse(old) + 8 * 60 * 60_000).toISOString().replace("Z", "+08:00");
    expect(checkOperations({ operations: [operation(offset)] }).status).toBe(0);
    for (const [finishedAt, updatedAt] of [[null, null], ["invalid", old], [null, "invalid"],
      [old.replace("Z", ""), null]] as const) {
      const invalid = checkOperations({ operations: [operation(finishedAt, updatedAt)] });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("STOP: invalid finishedAt/updatedAt");
      expect(invalid.stdout).not.toContain("activeOperation: none");
    }
  });
});
