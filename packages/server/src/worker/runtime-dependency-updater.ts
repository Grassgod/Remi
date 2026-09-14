import { spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { activateRuntimeSelection, runtimeUpdateSettings, runtimeUpdateStatus, saveRuntimeUpdateStatus, selectedRuntimeVersions, type RuntimeUpdateSettings, type RuntimeUpdateStatus } from "@acp/runtime-update-state.js";
import { validRuntimeVersions, versionsAtLeast, type RuntimeProvider, type RuntimeSelection } from "@acp/runtime-versions.js";
import { runtimeBundleBridge, runtimeBundlePrefix } from "@acp/runtime-bundle.js";

export interface RuntimeUpdateParticipant {
  ready(): boolean;
  busy(): boolean;
  maintenance(): boolean;
  pause(): void;
  release(): void;
  restart(): void;
}

interface UpdaterDependencies {
  now(): number;
  settings(): RuntimeUpdateSettings;
  status(): RuntimeUpdateStatus | null;
  save(status: RuntimeUpdateStatus): void;
  current(provider: RuntimeProvider): ReturnType<typeof selectedRuntimeVersions>;
  prepare(providers: RuntimeProvider[], signal: AbortSignal): Promise<RuntimeSelection>;
  activate(selection: RuntimeSelection): void;
  requiresActivation(selection: RuntimeSelection): boolean;
  log(message: string): void;
  startupDelayMs: number;
}

/** One checker for all provider lanes in a supervisor; slow work lives in a child process. */
export class RuntimeDependencyUpdater {
  private readonly participants: RuntimeUpdateParticipant[] = [];
  private readonly deps: UpdaterDependencies;
  private readonly startedAt: number;
  private lastCheck = 0;
  private failed = false;
  private initialized = false;
  private settingsRefreshAt = 0;
  private settings: RuntimeUpdateSettings = { enabled: false, intervalHours: 24 };
  private pending: RuntimeSelection | null = null;
  private work: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopped = false;

  constructor(private readonly providers: RuntimeProvider[], dependencies: Partial<UpdaterDependencies> = {}) {
    this.deps = {
      now: Date.now, settings: runtimeUpdateSettings, status: runtimeUpdateStatus, save: saveRuntimeUpdateStatus,
      current: selectedRuntimeVersions, prepare: prepareRuntimeUpdateInChild, activate: activateRuntimeSelection,
      requiresActivation: runtimeSelectionNeedsActivation,
      log: (message) => console.error(`[runtime-update] ${message}`), startupDelayMs: 60_000,
      ...dependencies,
    };
    this.startedAt = this.deps.now();
  }

  register(participant: RuntimeUpdateParticipant): void { this.participants.push(participant); }
  get draining(): boolean { return this.pending !== null && this.settings.enabled && !this.stopped; }
  get checking(): boolean { return this.work !== null; }

  /** Called by each lane's heartbeat; never waits for registry, npm or ACP. */
  tick(): void {
    if (this.stopped || !this.providers.length) return;
    const now = this.deps.now();
    if (!this.initialized && now < this.settingsRefreshAt) return;
    try {
      if (!this.initialized || now >= this.settingsRefreshAt) {
        this.settings = this.deps.settings();
        this.settingsRefreshAt = now + 10_000;
        if (!this.initialized) {
          const previous = this.deps.status();
          // Interrupted preparations/waits are rechecked after restart instead of trusting an unverified receipt.
          this.lastCheck = previous && ["current", "updated", "failed"].includes(previous.status) ? previous.checkedAt : 0;
          this.failed = previous?.status === "failed";
          this.initialized = true;
        }
      }
      if (!this.settings.enabled) {
        this.abort?.abort();
        if (this.pending || this.work) this.deps.save({ checkedAt: this.lastCheck, status: "disabled" });
        this.pending = null;
        return;
      }
      if (this.participants.length === 0 || this.participants.some((p) => !p.ready() || p.maintenance())) return;
      if (this.pending) {
        // Claim pumps observe draining before issuing another claim; an already-issued claim is included in busy().
        if (this.participants.some((p) => p.busy())) return;
        const selection = this.pending;
        for (const participant of this.participants) participant.pause();
        try { this.deps.activate(selection); }
        catch (error) {
          for (const participant of this.participants) participant.release();
          throw error;
        }
        this.pending = null;
        this.stopped = true;
        try { this.deps.save({ checkedAt: now, status: "updated", versions: selection }); }
        catch (error) { this.deps.log(`Could not save update status: ${String(error)}`); }
        this.deps.log("Verified runtime updates selected; restarting idle daemon lanes");
        for (const participant of this.participants) participant.restart();
        return;
      }
      const interval = Math.min(this.settings.intervalHours, this.failed ? 1 : this.settings.intervalHours) * 3_600_000;
      if (this.work || now - this.startedAt < this.deps.startupDelayMs || (this.lastCheck && now - this.lastCheck < interval)) return;
      this.lastCheck = now;
      this.deps.save({ checkedAt: now, status: "checking" });
      const abort = this.abort = new AbortController();
      this.work = Promise.resolve().then(() => this.deps.prepare(this.providers, abort.signal)).then((selection) => {
        if (abort.signal.aborted || this.stopped) return;
        validatePreparedSelection(selection, this.providers, this.deps.current);
        const changed = this.deps.requiresActivation(selection) || this.providers.some((provider) => {
          const current = this.deps.current(provider), next = selection[provider]!;
          return current.acp !== next.acp || current.sdk !== next.sdk || current.executable !== next.executable;
        });
        this.failed = false;
        this.pending = changed ? selection : null;
        this.deps.save({ checkedAt: this.lastCheck, status: changed ? "waiting_for_tasks" : "current", versions: selection });
        if (changed) this.deps.log("New stable runtimes verified; pausing new claims until current tasks finish");
      }).catch((error) => {
        if (!abort.signal.aborted && !this.stopped) this.recordFailure(error);
      }).finally(() => { this.work = null; this.abort = null; });
    } catch (error) {
      this.settingsRefreshAt = now + 60_000;
      this.recordFailure(error);
    }
  }

  private recordFailure(error: unknown): void {
    this.pending = null;
    this.failed = true;
    this.lastCheck = this.deps.now();
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log(`Keeping current runtimes: ${message}`);
    try { this.deps.save({ checkedAt: this.lastCheck, status: "failed", error: message.slice(0, 1000) }); }
    catch { /* Filesystem failures must not take down task execution. */ }
  }

  stop(): void { this.stopped = true; this.pending = null; this.abort?.abort(); }
  async settled(): Promise<void> { await this.work; }
}

/** A prepared package existing on disk does not prove the daemon's launchers use it yet. */
export function runtimeSelectionNeedsActivation(selection: RuntimeSelection): boolean {
  return (Object.keys(selection) as RuntimeProvider[]).some((provider) => {
    const bridge = runtimeBundleBridge(provider, runtimeBundlePrefix(provider, selection[provider]!));
    if (provider === "claude") return process.env.REMI_CLAUDE_AGENT_ACP_DIR !== bridge;
    const launcher = join(process.env.REMI_HOME ?? join(homedir(), ".remi"), "bin", "codex-acp");
    try { return resolve(dirname(launcher), readlinkSync(launcher)) !== join(bridge, "dist", "index.js"); }
    catch { return true; }
  });
}

export function validatePreparedSelection(selection: RuntimeSelection, providers: RuntimeProvider[], current = selectedRuntimeVersions): void {
  if (!selection || typeof selection !== "object" || Object.keys(selection).length !== providers.length
    || providers.some((provider) => !validRuntimeVersions(selection[provider]) || !versionsAtLeast(selection[provider]!, current(provider)))) {
    throw new Error("Runtime preparation returned missing, invalid or downgraded versions");
  }
}

export function runtimeUpdateCommand(providers: RuntimeProvider[], execPath = process.execPath): string[] {
  const executable = basename(execPath).toLowerCase();
  const source = executable === "bun" || executable === "bun.exe" || executable.startsWith("bun-debug");
  return [execPath, ...(source ? [fileURLToPath(new URL("../../../../apps/remi/main.ts", import.meta.url))] : []),
    "runtime", "prepare", "--latest", ...providers.flatMap((provider) => ["--provider", provider])];
}

export function hasCustomRuntimeOverride(provider: RuntimeProvider): boolean {
  if (provider === "codex") return Boolean(process.env.CODEX_PATH || process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE);
  const bridge = process.env.REMI_CLAUDE_AGENT_ACP_DIR;
  const managed = join(process.env.REMI_HOME ?? join(homedir(), ".remi"), "acp") + "/";
  const wrapper = process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE;
  return Boolean(process.env.REMI_CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_CODE_EXECUTABLE
    || (wrapper && basename(wrapper) !== "remi-claude-agent-acp")
    || (bridge && !bridge.startsWith(managed)));
}

export function prepareRuntimeUpdateInChild(providers: RuntimeProvider[], signal: AbortSignal,
  options: { command?: string[]; timeoutMs?: number } = {}): Promise<RuntimeSelection> {
  signal.throwIfAborted();
  const command = options.command ?? runtimeUpdateCommand(providers);
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "", diagnostic = "", settled = false;
    const kill = () => {
      if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      try { child.kill("SIGKILL"); } catch {}
    };
    const finish = (error?: Error, result?: RuntimeSelection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("Runtime preparation cancelled"));
    const timer = setTimeout(() => finish(new Error("Runtime preparation timed out")), options.timeoutMs ?? 10 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.on("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) finish(new Error("Runtime preparation output exceeded limit"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.on("exit", (code, exitSignal) => {
      if (code !== 0) finish(new Error(`Runtime preparation failed (${exitSignal ?? code}): ${diagnostic.trim()}`));
      else kill();
    });
    child.on("close", (code) => {
      if (settled || code !== 0) return;
      try {
        const result = JSON.parse(output);
        if (result.verified !== true || result.activated !== false) throw new Error("Invalid preparation receipt");
        validatePreparedSelection(result.versions, providers);
        finish(undefined, result.versions);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
