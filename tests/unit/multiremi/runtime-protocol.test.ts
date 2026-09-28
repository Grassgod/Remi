import { afterEach, describe, expect, it } from "bun:test";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { formatRuntimeProtocol, runtimeProtocolSummary } from "@multiremi/contracts/runtime-protocol";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

afterEach(resetMultiremiTestEnv);

describe("database-derived runtime protocol", () => {
  it("derives all four states and never exposes an ACP/agent failure as a CLI protocol failure", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ id: "rt_protocol", name: "Protocol", provider: "claude", daemonId: "dmn_protocol", metadata: { cli_version: "0.2.82" } });
    expect(store.getRuntime(runtime.id)?.protocol).toEqual({ version: 1, state: "rejected", min_version: DAEMON_MIN_CLI_VERSION, last_error: null });
    const cli = store.createRuntimeUpdateRequest(runtime.id, { targetVersion: DAEMON_MIN_CLI_VERSION });
    expect(store.getRuntime(runtime.id)?.protocol?.state).toBe("upgrade_pending");
    store.reportRuntimeUpdateResult(runtime.id, cli.id, { status: "failed", error: "Permission denied" });
    const failed = store.getRuntime(runtime.id)!.protocol!;
    expect(failed.state).toBe("upgrade_failed");
    expect(formatRuntimeProtocol(failed)).toBe("协议 v1 · 升级失败：Permission denied");
    const acp = store.createRuntimeUpdateRequest(runtime.id, { scope: "acp" });
    store.reportRuntimeUpdateResult(runtime.id, acp.id, { status: "failed", error: "ACP-only failure" });
    expect(store.getRuntime(runtime.id)?.protocol?.last_error).toBe("Permission denied");
    store.recordDaemonProtocol(runtime.id, "dmn_protocol", 2, DAEMON_MIN_CLI_VERSION);
    expect(store.getRuntime(runtime.id)?.protocol).toEqual({ version: 2, state: "ok", min_version: DAEMON_MIN_CLI_VERSION, last_error: null });
    // A rollback to an older binary must not inherit a healthy v2 state.
    store.updateRuntime(runtime.id, { metadata: { cli_version: "0.2.82" } });
    expect(store.getRuntime(runtime.id)?.protocol?.state).toBe("upgrade_failed");
  });

  it("does not write another daemon's runtime while persisting a hello", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ id: "rt_foreign", name: "Foreign", provider: "claude", daemonId: "dmn_owner", metadata: { cli_version: "0.2.82" } });
    store.recordDaemonProtocol(runtime.id, "dmn_other", 2, DAEMON_MIN_CLI_VERSION);
    expect(store.getRuntime(runtime.id)?.daemonProtocolVersion).toBeNull();
    expect(store.getRuntime(runtime.id)?.metadata.cli_version).toBe("0.2.82");
    expect(() => store.recordDaemonProtocol("deleted", "dmn_owner", 2, DAEMON_MIN_CLI_VERSION)).not.toThrow();
  });

  it("keeps workspace-batched protocol states identical to the per-runtime read", () => {
    const store = createLocalStore();
    const expectedStates = ["rejected", "upgrade_failed", "upgrade_pending", "ok"] as const;
    for (const state of expectedStates) {
      const runtime = store.registerRuntime({ id: `rt_${state}`, name: state, provider: "claude", daemonId: `dmn_${state}`,
        metadata: { cli_version: "0.2.82" } });
      if (state !== "rejected") {
        const failed = store.createRuntimeUpdateRequest(runtime.id, { scope: "cli", targetVersion: DAEMON_MIN_CLI_VERSION });
        store.reportRuntimeUpdateResult(runtime.id, failed.id, { status: "failed", error: "CLI fixture failure" });
        const acp = store.createRuntimeUpdateRequest(runtime.id, { scope: "acp" });
        store.reportRuntimeUpdateResult(runtime.id, acp.id, { status: "failed", error: "Must not replace CLI failure" });
      }
      if (state === "upgrade_pending") store.createRuntimeUpdateRequest(runtime.id, { scope: "cli", targetVersion: DAEMON_MIN_CLI_VERSION });
      if (state === "ok") store.recordDaemonProtocol(runtime.id, `dmn_${state}`, 2, DAEMON_MIN_CLI_VERSION);
    }
    const listed = store.listRuntimesForWorkspace("local");
    expect(listed).toHaveLength(4);
    for (const state of expectedStates) {
      const runtime = listed.find(runtime => runtime.id === `rt_${state}`)!;
      expect(runtime.protocol?.state).toBe(state);
      expect(runtime.protocol).toEqual(store.getRuntime(runtime.id)?.protocol);
    }
  });

  it("adds exactly one nullable runtime column idempotently without modifying the update table", () => {
    createLocalStore();
    db!.exec("ALTER TABLE multiremi_runtimes DROP COLUMN daemon_protocol_version");
    const before = db!.query("PRAGMA table_info(multiremi_runtime_update_requests)").all();
    runMigrations(db! as unknown as SqlDatabase);
    runMigrations(db! as unknown as SqlDatabase);
    const column = (db!.query("PRAGMA table_info(multiremi_runtimes)").all() as any[]).filter(row => row.name === "daemon_protocol_version");
    expect(column).toHaveLength(1);
    expect(column[0]).toMatchObject({ type: "INTEGER", notnull: 0, dflt_value: null });
    expect(db!.query("PRAGMA table_info(multiremi_runtime_update_requests)").all()).toEqual(before);
  });

  it("counts physical machines once with failure precedence and excludes cloud workers", () => {
    const protocol = (state: "ok" | "upgrade_pending" | "upgrade_failed" | "rejected") => ({ version: 1, state, min_version: DAEMON_MIN_CLI_VERSION, last_error: null });
    expect(runtimeProtocolSummary([
      { id: "r1", daemonId: "d1", runtimeMode: "local", protocol: protocol("upgrade_pending") },
      { id: "r2", daemonId: "d1", runtimeMode: "local", protocol: protocol("upgrade_failed") },
      { id: "r3", daemonId: "d2", runtimeMode: "local", protocol: protocol("rejected") },
      { id: "r4", daemonId: "d2", runtimeMode: "local", protocol: protocol("ok") },
      { id: "r5", daemonId: "d3", runtimeMode: "local", protocol: protocol("ok") },
      { id: "r6", daemonId: "d4", runtimeMode: "cloud", protocol: protocol("rejected") },
    ])).toEqual({ pending: 1, failed: 1 });
  });
});
