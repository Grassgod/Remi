import { expect, test } from "bun:test";
import { RuntimeDependencyUpdater, prepareRuntimeUpdateInChild, runtimeUpdateCommand, type RuntimeUpdateParticipant } from "@multiremi/worker/runtime-dependency-updater.js";
import { releaseRuntimeVersions, type RuntimeSelection } from "@acp/runtime-versions.js";
import type { RuntimeUpdateStatus } from "@acp/runtime-update-state.js";

const future: RuntimeSelection = {
  claude: { acp: "9.0.0", sdk: "9.0.0", executable: "9.0.0" },
  codex: { acp: "9.0.0", sdk: "9.0.0", executable: "9.0.0" },
};
function fixture(options: { selection?: RuntimeSelection; failure?: boolean; status?: RuntimeUpdateStatus; activationFailure?: boolean; staleLauncher?: boolean } = {}) {
  let now = 1_000_000, calls = 0, activated = 0;
  const settings = { enabled: true, intervalHours: 24 };
  const statuses: RuntimeUpdateStatus[] = [];
  const participants = ["claude", "codex"].map(() => ({ busy: false, ready: true, maintenance: false, paused: false, restarts: 0 }));
  const updater = new RuntimeDependencyUpdater(["claude", "codex"], {
    now: () => now, settings: () => ({ ...settings }), status: () => options.status ?? null,
    save: (status) => { statuses.push(status); }, current: releaseRuntimeVersions, startupDelayMs: 0, log: () => {},
    requiresActivation: () => options.staleLauncher ?? false,
    prepare: async () => { calls++; if (options.failure) throw Error("registry unavailable"); return options.selection ?? future; },
    activate: () => {
      expect(participants.every((p) => p.paused)).toBe(true);
      if (options.activationFailure) throw Error("disk full");
      activated++;
    },
  });
  for (const state of participants) updater.register({
    ready: () => state.ready, busy: () => state.busy, maintenance: () => state.maintenance,
    pause: () => { state.paused = true; }, release: () => { state.paused = false; }, restart: () => { state.restarts++; },
  } satisfies RuntimeUpdateParticipant);
  return { updater, settings, statuses, participants, calls: () => calls, activated: () => activated, advance: (ms: number) => { now += ms; } };
}

test("background preparation does not pause active tasks; verified updates wait for all lanes without a task timeout", async () => {
  const f = fixture();
  f.participants[1]!.busy = true;
  f.updater.tick();
  expect(f.updater.draining).toBe(false);
  expect(f.participants.some((p) => p.paused)).toBe(false);
  await f.updater.settled();
  expect(f.updater.draining).toBe(true);
  for (let hour = 0; hour < 48; hour++) { f.advance(3_600_000); f.updater.tick(); }
  expect(f.calls()).toBe(1);
  expect(f.activated()).toBe(0);
  expect(f.statuses.at(-1)?.status).toBe("waiting_for_tasks");
  f.participants[1]!.busy = false;
  f.updater.tick();
  expect(f.activated()).toBe(1);
  expect(f.participants.map((p) => p.restarts)).toEqual([1, 1]);
  expect(f.statuses.at(-1)?.status).toBe("updated");
});

test("multiple heartbeat ticks single-flight the check; unchanged versions never restart", async () => {
  const f = fixture({ selection: { claude: releaseRuntimeVersions("claude"), codex: releaseRuntimeVersions("codex") } });
  for (let i = 0; i < 10; i++) f.updater.tick();
  await f.updater.settled();
  expect(f.calls()).toBe(1);
  expect(f.updater.draining).toBe(false);
  f.updater.tick();
  expect(f.calls()).toBe(1);
  expect(f.activated()).toBe(0);
  f.advance(24 * 3_600_000);
  f.updater.tick(); await f.updater.settled();
  expect(f.calls()).toBe(2);
});

test("failed verification preserves the old runtime, releases claims and backs off for an hour", async () => {
  const f = fixture({ failure: true });
  f.updater.tick(); await f.updater.settled();
  expect(f.statuses.at(-1)?.status).toBe("failed");
  expect(f.updater.draining).toBe(false);
  expect(f.activated()).toBe(0);
  f.advance(30 * 60_000); f.updater.tick();
  expect(f.calls()).toBe(1);
  f.advance(30 * 60_000); f.updater.tick(); await f.updater.settled();
  expect(f.calls()).toBe(2);
});

test("a repaired baseline bundle still activates when the current launcher points to a legacy runtime", async () => {
  const f = fixture({ selection: { claude: releaseRuntimeVersions("claude"), codex: releaseRuntimeVersions("codex") }, staleLauncher: true });
  f.updater.tick(); await f.updater.settled();
  expect(f.updater.draining).toBe(true);
  f.updater.tick();
  expect(f.activated()).toBe(1);
});

test("shutdown aborts preparation and cannot activate a late receipt", async () => {
  let complete!: (selection: RuntimeSelection) => void;
  let signal!: AbortSignal;
  let activated = false;
  const updater = new RuntimeDependencyUpdater(["claude", "codex"], {
    now: () => 1000, startupDelayMs: 0, settings: () => ({ enabled: true, intervalHours: 24 }),
    status: () => null, save: () => {}, current: releaseRuntimeVersions, requiresActivation: () => false, log: () => {},
    prepare: async (_providers, value) => { signal = value; return new Promise((resolve) => { complete = resolve; }); },
    activate: () => { activated = true; },
  });
  updater.register({ ready: () => true, busy: () => false, maintenance: () => false, pause: () => {}, release: () => {}, restart: () => {} });
  updater.tick(); await Promise.resolve();
  updater.stop();
  expect(signal.aborted).toBe(true);
  complete(future); await updater.settled(); updater.tick();
  expect(activated).toBe(false);
  expect(updater.draining).toBe(false);
});

test("disabled policy clears a pending drain without changing dependencies", async () => {
  const f = fixture();
  f.participants[0]!.busy = true;
  f.updater.tick(); await f.updater.settled();
  f.settings.enabled = false; f.advance(10_000); f.updater.tick();
  expect(f.updater.draining).toBe(false);
  expect(f.activated()).toBe(0);
  expect(f.statuses.at(-1)?.status).toBe("disabled");
});

test("activation failure releases every paused lane", async () => {
  const f = fixture({ activationFailure: true });
  f.updater.tick(); await f.updater.settled(); f.updater.tick();
  expect(f.participants.every((p) => !p.paused && !p.restarts)).toBe(true);
  expect(f.updater.draining).toBe(false);
  expect(f.statuses.at(-1)?.error).toContain("disk full");
});

test("readiness and existing maintenance block activation", async () => {
  const f = fixture();
  f.updater.tick(); await f.updater.settled();
  f.participants[1]!.ready = false; f.updater.tick();
  expect(f.activated()).toBe(0);
  f.participants[1]!.ready = true; f.participants[0]!.maintenance = true; f.updater.tick();
  expect(f.activated()).toBe(0);
  f.participants[0]!.maintenance = false; f.updater.tick();
  expect(f.activated()).toBe(1);
});

test("restart honors persisted successful check time", async () => {
  const f = fixture({ status: { checkedAt: 999_999, status: "updated" } });
  f.updater.tick(); await f.updater.settled();
  expect(f.calls()).toBe(0);
  f.advance(24 * 3_600_000); f.updater.tick(); await f.updater.settled();
  expect(f.calls()).toBe(1);
});

test("a receipt missing a provider cannot activate a partial update", async () => {
  const f = fixture({ selection: { claude: future.claude } });
  f.updater.tick(); await f.updater.settled(); f.updater.tick();
  expect(f.activated()).toBe(0);
  expect(f.statuses.at(-1)?.status).toBe("failed");
});

test("source and compiled daemons invoke the same registered preparation command", () => {
  expect(runtimeUpdateCommand(["codex"], "/opt/remi")).toEqual(["/opt/remi", "runtime", "prepare", "--latest", "--provider", "codex"]);
  expect(runtimeUpdateCommand(["claude"], "/opt/bun").slice(-5)).toEqual(["runtime", "prepare", "--latest", "--provider", "claude"]);
});

test("child preparation accepts a verified receipt, rejects failures and enforces a deadline", async () => {
  const signal = new AbortController().signal;
  const receipt = JSON.stringify({ versions: future, verified: true, activated: false });
  const command = [process.execPath, "-e", `console.log(${JSON.stringify(receipt)})`];
  await expect(prepareRuntimeUpdateInChild(["claude", "codex"], signal, { command })).resolves.toEqual(future);
  await expect(prepareRuntimeUpdateInChild(["claude"], signal, { command: [process.execPath, "-e", "process.exit(1)"] })).rejects.toThrow("failed");
  await expect(prepareRuntimeUpdateInChild(["claude"], signal, { command: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 50 })).rejects.toThrow("timed out");
});
