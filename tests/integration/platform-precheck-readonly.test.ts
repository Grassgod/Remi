import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";

const repoRoot = resolve(import.meta.dir, "../..");
const readme = readFileSync(resolve(repoRoot, "deploy/README.md"), "utf8");
const scriptMatch = readme.match(/remi platform operation list[^\n]*\| python3 -c "([\s\S]*?)\n  "/u);
if (!scriptMatch) throw new Error("README operation pre-check script is missing");
const pythonScript = scriptMatch[1]!.replace(/^  /gmu, "").replaceAll('\\"', '"');
const authWrite = "UPDATE multiremi_access_tokens SET last_used_at = ? WHERE id = ?";
const scenarios = ["expired-drain", "missing-state", "active-operation"] as const;
type Scenario = typeof scenarios[number];
interface Write { sql: string; changes: number }

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
  const raw = new Database(":memory:");
  const audit = { recording: false, writes: [] as Write[] };
  const store = new MultiremiStore(auditedDatabase(raw, audit));
  store.ensureLocalWorkspace();
  const credential = await store.createAccessToken({ name: "MUL-464 local HTTP audit", type: "pat" });
  let activeId: string | null = null;
  if (scenario !== "missing-state") {
    store.getPlatformState();
    store.getPlatformMaintenance();
    const operation = store.createPlatformOperation({ kind: "restart" }, "local");
    if (scenario === "expired-drain") {
      store.reportPlatformOperation(operation.id, { status: "succeeded" });
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

function assertOnlyAuthWrites(writes: Write[], requestCount = 1) {
  expect(writes, "only last_used_at authentication bookkeeping may be written").toEqual(
    Array.from({ length: requestCount }, () => ({ sql: authWrite, changes: 1 })),
  );
}

describe("MUL-464 operation pre-check over real loopback HTTP and SQLite", () => {
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
      } finally { f.close(); }
    });

    test(`status control executes maintenance writes: ${scenario}`, async () => {
      const f = await fixture(scenario);
      try {
        await f.request("/api/multiremi/platform/status");
        expect(f.audit.writes[0]).toEqual({ sql: authWrite, changes: 1 });
        const stateWrites = f.audit.writes.filter((write) => write.sql.includes("multiremi_platform_state"));
        const maintenanceWrites = f.audit.writes.filter((write) => write.sql.includes("multiremi_platform_maintenance"));
        expect(stateWrites.map((write) => write.changes)).toEqual([scenario === "missing-state" ? 1 : 0]);
        expect(maintenanceWrites.map((write) => write.changes)).toEqual(
          scenario === "expired-drain" ? [0, 1] : [scenario === "missing-state" ? 1 : 0],
        );
        expect(f.audit.writes).toHaveLength(scenario === "expired-drain" ? 4 : 3);
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
        // The CLI negotiates capabilities before the operations GET.
        expect(f.requests).toEqual(["GET /api/cli/capabilities", "GET /api/multiremi/platform/operations"]);
        assertOnlyAuthWrites(f.audit.writes, 2);
        expect(f.snapshot()).toEqual(f.before);
        const gate = checkOperations(body);
        expect(gate.status, gate.stderr).toBe(scenario === "missing-state" ? 0 : 1);
        expect(gate.stdout.trim()).toBe(scenario === "missing-state"
          ? "activeOperation: none" : `activeOperation: ${f.activeId} restart rolling_back`);
      } finally { f.close(); }
    }
  });

  test("the pre-check refuses non-terminal, unknown, full and malformed responses", () => {
    const operation = (status: string) => ({ id: "pop_local", kind: "restart", status });
    for (const status of ["queued", "preparing", "pulling", "draining", "switching",
      "restarting", "verifying", "rolling_back", "future_status"]) {
      const gate = checkOperations({ operations: [operation("succeeded"), operation(status)] });
      expect(gate.status, status).toBe(1);
      expect(gate.stdout.trim()).toBe(`activeOperation: pop_local restart ${status}`);
    }
    const terminalHistory = ["succeeded", "failed", "cancelled", "rolled_back"].map(operation);
    expect(checkOperations({ operations: terminalHistory }).status).toBe(0);
    const full = checkOperations({ operations: Array.from({ length: 100 }, () => operation("succeeded")) });
    expect(full.status).toBe(1);
    expect(full.stdout).not.toContain("activeOperation: none");
    expect(full.stderr).toContain("full operation list");
    for (const body of [{}, { operations: null }, { operations: [{}] }]) {
      const gate = checkOperations(body);
      expect(gate.status).not.toBe(0);
      expect(gate.stdout).not.toContain("activeOperation: none");
    }
  });
});
