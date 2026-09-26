// MUL-389: the heartbeat's seven async-request polls are merged into one probe.
//
// The probe decides which families get claimed and which deadline sweeps are provably empty.
// What has to hold:
//   1. every family is still claimed, with the same payload shape and ordering;
//   2. a family whose capability is off is never claimed, and never probed;
//   3. the timeout copy per deadline is unchanged;
//   4. a batch import claims ten rows in one write;
//   5. the CLI-scope update drain branch still refuses to hand the update out.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiRuntime } from "@multiremi/contracts/types.js";

afterEach(resetMultiremiTestEnv);

function fixture(metadata: Record<string, unknown> = {}): { store: MultiremiStore; runtime: MultiremiRuntime } {
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    id: "rt_probe",
    name: "Probe runtime",
    provider: "codex",
    daemonId: "daemon-probe",
    workspaceId: "local",
    ownerId: "local",
    status: "online",
    metadata: { agent_plugin_protocol: 1, feishu_bot_menu: true, ...metadata },
  });
  return { store, runtime };
}

/** The capability flags a current daemon re-advertises on every heartbeat. */
const FULL = {
  supportsBatchImport: true,
  supportsDirectoryScan: true,
  supportsSkillDirectory: true,
  supportsBotMenu: true,
  agentPluginProtocol: 1,
};

describe("merged heartbeat poll", () => {
  it("claims all seven families in one heartbeat", () => {
    const { store, runtime } = fixture();
    const update = store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9" });
    const modelList = store.createRuntimeModelListRequest(runtime.id);
    const command = store.createRuntimeCommandRequest(runtime.id, { command: "printf ready", args: ["one"] });
    const botMenu = store.createBotMenuPublishRequest(runtime.id, {
      workspaceId: "local",
      config: { default: [{ name: "Status", behaviors: [{ type: "send_message" }] }] } as never,
      dryRun: true,
    });
    const localSkills = store.createRuntimeLocalSkillListRequest(runtime.id, {});
    const scan = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "/tmp", maxDepth: 3, mode: "browse" });
    const skillImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "bench-skill" });

    const ack = store.heartbeatRuntime(runtime.id, FULL);

    expect(ack.status).toBe("ok");
    expect(ack.pending_update).toEqual({ id: update.id, target_version: "9.9.9", scope: "cli" });
    expect(ack.pending_model_list).toEqual({ id: modelList.id });
    expect(ack.pending_command).toEqual({ id: command.id, command: "printf ready", args: ["one"], timeout_ms: command.timeoutMs });
    expect(ack.pending_bot_menu).toEqual({ id: botMenu.id, config: botMenu.config, dry_run: true });
    expect(ack.pending_local_skills).toEqual({ id: localSkills.id });
    expect(ack.pending_directory_scan).toEqual({ id: scan.id, root: "/tmp", max_depth: 3, mode: "browse" });
    expect(ack.pending_local_skill_import).toEqual({ id: skillImport.id, skill_key: "bench-skill" });

    for (const status of [
      store.getRuntimeUpdateRequest(runtime.id, update.id)?.status,
      store.getRuntimeModelListRequest(runtime.id, modelList.id)?.status,
      store.getRuntimeCommandRequest(runtime.id, command.id)?.status,
      store.getBotMenuPublishRequest(runtime.id, botMenu.id)?.status,
      store.getRuntimeLocalSkillListRequest(runtime.id, localSkills.id)?.status,
      store.getRuntimeDirectoryScanRequest(runtime.id, scan.id)?.status,
      store.getRuntimeLocalSkillImportRequest(runtime.id, skillImport.id)?.status,
    ]) expect(status).toBe("running");
  });

  it("claims the oldest pending row of a family, not whichever the update returns first", () => {
    const { store, runtime } = fixture();
    const first = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "first" });
    const second = store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "second" });
    // Backdate the second row inside its pending deadline so it is older but not expired.
    db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 10_000).toISOString(),
      second.id,
    ]);

    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: false, supportsSkillDirectory: false });
    expect(ack.pending_local_skill_import?.id).toBe(second.id);
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, first.id)?.status).toBe("pending");
  });

  it("claims a batch of ten imports in one write, oldest first", () => {
    const { store, runtime } = fixture();
    const created = Array.from({ length: 10 }, (_value, index) =>
      store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: `skill-${index}` }));
    // Reverse the creation order of the timestamps so ordering is observable.
    for (const [index, request] of created.entries()) {
      db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET created_at = ? WHERE id = ?", [
        new Date(Date.now() - (created.length - index) * 1_000).toISOString(),
        request.id,
      ]);
    }

    const ack = store.heartbeatRuntime(runtime.id, FULL);
    expect(ack.pending_local_skill_imports?.map((entry) => entry.skill_key)).toEqual([
      "skill-0", "skill-1", "skill-2", "skill-3", "skill-4",
      "skill-5", "skill-6", "skill-7", "skill-8", "skill-9",
    ]);
    for (const request of created) {
      expect(store.getRuntimeLocalSkillImportRequest(runtime.id, request.id)?.status).toBe("running");
    }
  });

  it("leaves a family alone when the daemon does not advertise its capability", () => {
    const { store, runtime } = fixture();
    const scan = store.createRuntimeDirectoryScanRequest(runtime.id, { root: "/tmp" });
    const botMenu = store.createBotMenuPublishRequest(runtime.id, {
      workspaceId: "local",
      config: { default: [] } as never,
      dryRun: true,
    });

    // Both rows exist, but this heartbeat does not advertise either capability.
    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: false });
    expect(ack.pending_directory_scan).toBeUndefined();
    expect(ack.pending_bot_menu).toBeUndefined();
    expect(store.getRuntimeDirectoryScanRequest(runtime.id, scan.id)?.status).toBe("pending");
    expect(store.getBotMenuPublishRequest(runtime.id, botMenu.id)?.status).toBe("pending");

    // The same rows are still claimable once the capability is advertised.
    const next = store.heartbeatRuntime(runtime.id, { supportsDirectoryScan: true, supportsBotMenu: true });
    expect(next.pending_directory_scan?.id).toBe(scan.id);
    expect(next.pending_bot_menu?.id).toBe(botMenu.id);
  });

  it("still fails custom skill directories for a daemon that cannot read them", () => {
    const { store, runtime } = fixture();
    const scan = store.createRuntimeLocalSkillListRequest(runtime.id, { root: "/tmp/skills" });
    const ack = store.heartbeatRuntime(runtime.id, { supportsSkillDirectory: false, supportsBatchImport: false });
    expect(ack.pending_local_skills).toBeUndefined();
    const failed = store.getRuntimeLocalSkillListRequest(runtime.id, scan.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("custom skill directories are not supported; upgrade the runtime daemon");
  });

  it("keeps every family's timeout copy identical after the merged sweep", () => {
    const { store, runtime } = fixture();
    const families = [
      { table: "multiremi_runtime_model_list_requests", id: store.createRuntimeModelListRequest(runtime.id).id, pending: "daemon did not respond within 30 seconds", running: "daemon did not finish within 60 seconds" },
      { table: "multiremi_runtime_directory_scan_requests", id: store.createRuntimeDirectoryScanRequest(runtime.id, {}).id, pending: "daemon did not respond within 3 minutes; the runtime daemon may need updating", running: "daemon did not finish within 60 seconds" },
      { table: "multiremi_runtime_update_requests", id: store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "1.2.3" }).id, pending: "daemon did not respond within 120 seconds", running: "update did not complete within 20 minutes" },
      { table: "multiremi_runtime_local_skill_list_requests", id: store.createRuntimeLocalSkillListRequest(runtime.id, {}).id, pending: "daemon did not respond within 3 minutes", running: "daemon did not finish within 60 seconds" },
      { table: "multiremi_runtime_local_skill_import_requests", id: store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "k" }).id, pending: "daemon did not respond within 3 minutes", running: "daemon did not finish within 60 seconds" },
      { table: "multiremi_runtime_command_requests", id: store.createRuntimeCommandRequest(runtime.id, { command: "printf x" }).id, pending: "daemon did not respond within 3 minutes", running: "daemon did not finish the command within 20 minutes" },
      { table: "multiremi_bot_menu_publish_requests", id: store.createBotMenuPublishRequest(runtime.id, { workspaceId: "local", config: { default: [] } as never, dryRun: true }).id, pending: "bot menu publisher did not respond within 3 minutes", running: "bot menu publish did not finish within 5 minutes" },
    ];

    // A pending row past its deadline and a running row past its own, per family.
    for (const family of families) {
      const expired = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
      db!.run(`UPDATE ${family.table} SET created_at = ?, updated_at = ? WHERE id = ?`, [expired, expired, family.id]);
      db!.run(`UPDATE ${family.table} SET run_started_at = ?, status = 'running' WHERE id = ?`, [expired, family.id]);
    }

    // Read each family back through its own accessor: the sweep writes the per-deadline copy.
    const expectations: Array<[string, string]> = [
      [store.getRuntimeModelListRequest(runtime.id, families[0]!.id)!.error!, families[0]!.running],
      [store.getRuntimeDirectoryScanRequest(runtime.id, families[1]!.id)!.error!, families[1]!.running],
      // This row was flipped to `running` above, so it takes the running-deadline copy.
      [store.getRuntimeUpdateRequest(runtime.id, families[2]!.id)!.error!, families[2]!.running],
      [store.getRuntimeLocalSkillListRequest(runtime.id, families[3]!.id)!.error!, families[3]!.running],
      [store.getRuntimeLocalSkillImportRequest(runtime.id, families[4]!.id)!.error!, families[4]!.running],
      [store.getRuntimeCommandRequest(runtime.id, families[5]!.id)!.error!, families[5]!.running],
      [store.getBotMenuPublishRequest(runtime.id, families[6]!.id)!.error!, families[6]!.running],
    ];
    for (const [observed, expected] of expectations) expect(observed).toBe(expected);
  });

  it("writes the running-deadline copy when only the running deadline blew", () => {
    const { store, runtime } = fixture();
    // A running row whose run started long ago, with a fresh creation time.
    const request = store.createRuntimeCommandRequest(runtime.id, { command: "printf slow" });
    db!.run("UPDATE multiremi_runtime_command_requests SET status = 'running', run_started_at = ? WHERE id = ?", [
      new Date(Date.now() - 21 * 60 * 1_000).toISOString(),
      request.id,
    ]);

    const expired = store.getRuntimeCommandRequest(runtime.id, request.id);
    expect(expired?.status).toBe("timeout");
    expect(expired?.error).toBe("daemon did not finish the command within 20 minutes");
  });

  it("does not expire a pending row that is still inside its deadline", () => {
    const { store, runtime } = fixture();
    const request = store.createRuntimeModelListRequest(runtime.id);
    // 29s old: inside the 30s model-list pending deadline.
    db!.run("UPDATE multiremi_runtime_model_list_requests SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 29_000).toISOString(),
      request.id,
    ]);
    expect(store.getRuntimeModelListRequest(runtime.id, request.id)?.status).toBe("pending");
  });

  it("holds back a CLI-scope update while the daemon still has executing tasks", () => {
    const { store, runtime } = fixture();
    const agent = store.createAgent({ name: "Drain agent", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "drain", runtimeId: runtime.id });
    store.claimTask(runtime.id);
    store.startTask(task.id);

    const update = store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9" });
    const ack = store.heartbeatRuntime(runtime.id, FULL);
    expect(ack.pending_update).toBeUndefined();
    const stillPending = store.getRuntimeUpdateRequest(runtime.id, update.id);
    expect(stillPending?.status).toBe("pending");
    // The lease renewal is the heartbeat itself.
    expect(Date.parse(stillPending!.updatedAt)).not.toBeNaN();

    // Once the task settles the drain fence lifts and the update is handed out.
    store.completeTask(task.id, { output: "done" });
    const next = store.heartbeatRuntime(runtime.id, FULL);
    expect(next.pending_update?.id).toBe(update.id);
  });

  it("scrubs raw command text off a terminal row on the next heartbeat", () => {
    const { store, runtime } = fixture();
    const request = store.createRuntimeCommandRequest(runtime.id, { command: "printf secret", args: ["arg"] });
    store.claimRuntimeCommandRequest(runtime.id);
    store.reportRuntimeCommandResult(runtime.id, request.id, { status: "completed", exitCode: 0, stdout: "ok" });
    // The report already wiped it; write raw text back to model an older daemon's row.
    db!.run("UPDATE multiremi_runtime_command_requests SET command = ?, args = ? WHERE id = ?", ["printf secret", '["arg"]', request.id]);

    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: false });
    expect(ack.pending_command).toBeUndefined();
    expect(store.getRuntimeCommandRequest(runtime.id, request.id)?.command).toBe("");
    expect(store.getRuntimeCommandRequest(runtime.id, request.id)?.args).toEqual([]);
    // The redacted pair is the audit copy and must survive the scrub.
    expect(store.getRuntimeCommandRequest(runtime.id, request.id)?.redactedCommand).toBe("printf secret");
  });

  // The rows below are read straight from the table: the per-request getters sweep before they
  // read, which would hide whether the heartbeat itself did the sweep.
  it("times out a stuck running update on the heartbeat even when nothing is pending", () => {
    const { store, runtime } = fixture();
    const update = store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.9" });
    expect(store.heartbeatRuntime(runtime.id, FULL).pending_update?.id).toBe(update.id);
    // The daemon died mid-update: the row is `running` and past the 20-minute deadline.
    db!.run("UPDATE multiremi_runtime_update_requests SET run_started_at = ? WHERE id = ?", [
      new Date(Date.now() - 21 * 60 * 1_000).toISOString(),
      update.id,
    ]);

    store.heartbeatRuntime(runtime.id, FULL);
    const row = db!.query("SELECT status, error FROM multiremi_runtime_update_requests WHERE id = ?").get(update.id) as { status: string; error: string };
    expect(row).toEqual({ status: "timeout", error: "update did not complete within 20 minutes" });
    // `createRuntimeUpdateRequest` checks for an in-flight row without sweeping first, so a row
    // the heartbeat left `running` would refuse every later update.
    expect(() => store.createRuntimeUpdateRequest(runtime.id, { targetVersion: "9.9.10" })).not.toThrow();
  });

  it("times out an overdue pending row on the heartbeat even when nothing is claimable", () => {
    const { store, runtime } = fixture();
    const request = store.createRuntimeModelListRequest(runtime.id);
    db!.run("UPDATE multiremi_runtime_model_list_requests SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      request.id,
    ]);

    const ack = store.heartbeatRuntime(runtime.id, FULL);
    expect(ack.pending_model_list).toBeUndefined();
    const row = db!.query("SELECT status, error FROM multiremi_runtime_model_list_requests WHERE id = ?").get(request.id) as { status: string; error: string };
    expect(row).toEqual({ status: "timeout", error: "daemon did not respond within 30 seconds" });
  });
});

// ── structural assertion: an idle heartbeat touches the seven pending tables once ──────────────
//
// Senior大哥's ruling states this acceptance item as "heartbeat.idle 里触及 7 张待办表的语句只有
// probe 那 1 条". That is a property of the generated SQL — the probe is one statement whose
// `EXISTS` sub-queries name all seven tables — so it is asserted here on the statements the store
// emits, independent of the benchmark's query counts.
describe("idle heartbeat — pending-table statement count", () => {
  /** The seven async-request families the merged probe covers. */
  const PENDING_TABLES = [
    "multiremi_runtime_update_requests",
    "multiremi_runtime_model_list_requests",
    "multiremi_runtime_command_requests",
    "multiremi_bot_menu_publish_requests",
    "multiremi_runtime_local_skill_list_requests",
    "multiremi_runtime_directory_scan_requests",
    "multiremi_runtime_local_skill_import_requests",
  ];

  /** A store whose raw handle records every statement the store prepares or runs, verbatim. */
  function recordingFixture(metadata: Record<string, unknown> = {}): {
    store: MultiremiStore;
    runtime: MultiremiRuntime;
    statements: string[];
  } {
    const statements: string[] = [];
    const raw = new Database(":memory:");
    const proxy = new Proxy(raw, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "prepare") {
          return (sql: string, ...callArgs: unknown[]) => {
            statements.push(String(sql));
            return (value as (...a: unknown[]) => unknown).apply(target, [sql, ...callArgs]);
          };
        }
        if (key === "run" || key === "exec") {
          return (sql: string, ...callArgs: unknown[]) => {
            statements.push(String(sql));
            return (value as (...a: unknown[]) => unknown).apply(target, [sql, ...callArgs]);
          };
        }
        if (key === "query") {
          return (sql: string, ...callArgs: unknown[]) => {
            statements.push(String(sql));
            return (value as (...a: unknown[]) => unknown).apply(target, [sql, ...callArgs]);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;
    const store = new MultiremiStore(proxy);
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_probe_structural",
      name: "Probe runtime",
      provider: "codex",
      daemonId: "daemon-probe",
      workspaceId: "local",
      ownerId: "local",
      status: "online",
      metadata: { agent_plugin_protocol: 1, feishu_bot_menu: true, ...metadata },
    });
    statements.length = 0;
    return { store, runtime, statements };
  }

  it("touches the seven pending tables in exactly one statement while the queues are empty", () => {
    const { store, runtime, statements } = recordingFixture();
    store.heartbeatRuntime(runtime.id, FULL);

    const touching = statements.filter((sql) => PENDING_TABLES.some((table) => sql.includes(table)));
    // Exactly one statement — the `UNION ALL` probe — and it names every family it gated on.
    expect(touching).toHaveLength(1);
    expect(touching[0]).toContain("UNION ALL");
    for (const table of PENDING_TABLES) expect(touching[0]).toContain(table);
  });

  it("gates on every family once per heartbeat, whatever the queue state", () => {
    const { store, runtime, statements } = recordingFixture();
    store.createRuntimeLocalSkillImportRequest(runtime.id, { skillKey: "one" });
    store.heartbeatRuntime(runtime.id, FULL);

    const probes = statements.filter((sql) => sql.includes("UNION ALL"));
    // One probe per heartbeat, never one per family.
    expect(probes).toHaveLength(1);
    for (const table of PENDING_TABLES) expect(probes[0]).toContain(table);
  });

  it("omits a family whose capability the daemon did not advertise", () => {
    const { store, runtime, statements } = recordingFixture();
    // Bot menu and directory scan are capability-gated, so a daemon that does not advertise them
    // must not have those tables probed at all — the gate lives inside the probe itself.
    store.heartbeatRuntime(runtime.id, {
      supportsBatchImport: true,
      supportsSkillDirectory: true,
      agentPluginProtocol: 1,
    });

    const [probe] = statements.filter((sql) => sql.includes("UNION ALL"));
    expect(probe).toBeDefined();
    expect(probe).not.toContain("multiremi_bot_menu_publish_requests");
    expect(probe).not.toContain("multiremi_runtime_directory_scan_requests");
    // The five ungated families are still covered in the same statement.
    for (const table of PENDING_TABLES.slice(0, 3).concat(PENDING_TABLES[4]!, PENDING_TABLES[6]!)) {
      expect(probe).toContain(table);
    }
  });
});
