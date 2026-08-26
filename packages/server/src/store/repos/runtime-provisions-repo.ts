import { createId, nowIso } from "@multiremi/ids.js";
import { cleanOptionalString, nullableString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { computeScheduleNextRun } from "@multiremi/store/schedule.js";
import { type StoreContext } from "@multiremi/store/context.js";
import {
  MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS,
  MAX_RUNTIME_COMMAND_TIMEOUT_MS,
  normalizeRuntimeCommandTimeout,
} from "@multiremi/runtime-command-policy.js";
import {
  redactRuntimeCommandArgs,
  redactRuntimeCommandText,
} from "@multiremi/runtime-command-safety.js";
import type {
  CreateWorkspaceRuntimeProvisionInput,
  MultiremiRuntimeCommandRequest,
  MultiremiRuntimeProvisionKind,
  MultiremiRuntimeProvisionState,
  MultiremiRuntimeProvisionStatus,
  MultiremiRuntimeProvisionTriggerKind,
  MultiremiWorkspaceRuntimeProvision,
  UpdateWorkspaceRuntimeProvisionInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEZONE = "UTC";

export class RuntimeProvisionsRepo {
  constructor(private readonly ctx: StoreContext) {}

  list(workspaceId: string): MultiremiWorkspaceRuntimeProvision[] {
    return (this.ctx.db.query(
      "SELECT * FROM multiremi_workspace_runtime_provisions WHERE workspace_id = ? ORDER BY created_at ASC, id ASC",
    ).all(workspaceId) as Row[]).map(toProvision);
  }

  get(id: string): MultiremiWorkspaceRuntimeProvision | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_workspace_runtime_provisions WHERE id = ?").get(id) as Row | null;
    return row ? toProvision(row) : null;
  }

  create(workspaceId: string, input: CreateWorkspaceRuntimeProvisionInput): MultiremiWorkspaceRuntimeProvision {
    const values = normalizeProvisionInput(input);
    const id = createId("prov");
    const now = nowIso();
    const nextRunAt = values.enabled && values.triggerKinds.includes("cron")
      ? computeScheduleNextRun(values.cronExpression!, values.timezone)
      : null;
    const provision = this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO multiremi_workspace_runtime_provisions (
          id, workspace_id, kind, enabled, package, version, bin, registry,
          command, args, redacted_command, redacted_args, trigger_kinds,
          cron_expression, timezone, next_run_at, timeout_ms, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, workspaceId, values.kind, values.enabled ? 1 : 0, values.package, values.version,
          values.bin, values.registry, values.command, toJson(values.args), values.redactedCommand,
          toJson(values.redactedArgs), toJson(values.triggerKinds), values.cronExpression,
          values.timezone, nextRunAt, values.timeoutMs, input.createdBy ?? input.created_by ?? null, now, now,
        ],
      );
      const created = this.get(id)!;
      this.recordAudit(created, "create", input.createdBy ?? input.created_by ?? null);
      return created;
    })();
    if (provision.enabled && provision.triggerKinds.includes("on_change")) this.enqueueWorkspaceProvision(id);
    return this.get(id)!;
  }

  update(id: string, input: UpdateWorkspaceRuntimeProvisionInput): MultiremiWorkspaceRuntimeProvision {
    const current = this.get(id);
    if (!current) throw new Error(`Runtime provision not found: ${id}`);
    const merged: CreateWorkspaceRuntimeProvisionInput = {
      kind: input.kind ?? current.kind,
      enabled: input.enabled ?? current.enabled,
      package: input.package !== undefined ? input.package : current.package,
      version: input.version !== undefined ? input.version : current.version,
      bin: input.bin !== undefined ? input.bin : current.bin,
      registry: input.registry !== undefined ? input.registry : current.registry,
      command: input.command !== undefined ? input.command : current.command,
      args: input.args ?? current.args,
      triggerKinds: input.triggerKinds ?? input.trigger_kinds ?? current.triggerKinds,
      cronExpression: input.cronExpression !== undefined
        ? input.cronExpression
        : input.cron_expression !== undefined ? input.cron_expression : current.cronExpression,
      timezone: input.timezone !== undefined ? input.timezone : current.timezone,
      timeoutMs: input.timeoutMs ?? input.timeout_ms ?? current.timeoutMs,
      createdBy: current.createdBy,
    };
    const values = normalizeProvisionInput(merged);
    const now = nowIso();
    const nextRunAt = values.enabled && values.triggerKinds.includes("cron")
      ? computeScheduleNextRun(values.cronExpression!, values.timezone)
      : null;
    const provision = this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE multiremi_workspace_runtime_provisions
         SET kind = ?, enabled = ?, package = ?, version = ?, bin = ?, registry = ?, command = ?, args = ?,
             redacted_command = ?, redacted_args = ?, trigger_kinds = ?, cron_expression = ?, timezone = ?,
             next_run_at = ?, timeout_ms = ?, updated_at = ?
         WHERE id = ?`,
        [
          values.kind, values.enabled ? 1 : 0, values.package, values.version, values.bin, values.registry,
          values.command, toJson(values.args), values.redactedCommand, toJson(values.redactedArgs),
          toJson(values.triggerKinds), values.cronExpression, values.timezone, nextRunAt, values.timeoutMs, now, id,
        ],
      );
      const updated = this.get(id)!;
      this.recordAudit(updated, "update", input.createdBy ?? input.created_by ?? current.createdBy);
      return updated;
    })();
    if (provision.enabled && provision.triggerKinds.includes("on_change")) this.enqueueWorkspaceProvision(id);
    return this.get(id)!;
  }

  delete(id: string, actorId: string | null = null): boolean {
    const provision = this.get(id);
    if (!provision) return false;
    return this.ctx.db.transaction(() => {
      this.recordAudit(provision, "delete", actorId);
      return this.ctx.db.run("DELETE FROM multiremi_workspace_runtime_provisions WHERE id = ?", [id]).changes > 0;
    })();
  }

  listStates(provisionId: string): MultiremiRuntimeProvisionState[] {
    return (this.ctx.db.query(
      "SELECT * FROM multiremi_runtime_provision_states WHERE provision_id = ? ORDER BY runtime_id ASC",
    ).all(provisionId) as Row[]).map(toProvisionState);
  }

  enqueueRuntimeOnRegister(runtimeId: string): number {
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime?.workspaceId) return 0;
    const provisions = this.list(runtime.workspaceId)
      .filter((provision) => provision.enabled && provision.triggerKinds.includes("on_register"));
    for (const provision of provisions) this.enqueueProvisionForRuntime(provision, runtimeId);
    return provisions.length;
  }

  enqueueWorkspaceProvision(provisionId: string): number {
    const provision = this.get(provisionId);
    if (!provision?.enabled) return 0;
    const runtimes = this.ctx.runtimes().listRuntimes().filter((runtime) => runtime.workspaceId === provision.workspaceId);
    for (const runtime of runtimes) this.enqueueProvisionForRuntime(provision, runtime.id);
    return runtimes.length;
  }

  claimDue(now: Date = new Date()): MultiremiWorkspaceRuntimeProvision[] {
    const rows = this.ctx.db.query(
      `UPDATE multiremi_workspace_runtime_provisions
       SET next_run_at = NULL, updated_at = ?
       WHERE id IN (
         SELECT id FROM multiremi_workspace_runtime_provisions
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       )
       RETURNING *`,
    ).all(nowIso(), now.toISOString()) as Row[];
    return rows.map(toProvision).filter((provision) => provision.triggerKinds.includes("cron"));
  }

  advanceNextRun(id: string, from: Date = new Date()): MultiremiWorkspaceRuntimeProvision | null {
    const provision = this.get(id);
    if (!provision) return null;
    const nextRunAt = provision.enabled && provision.triggerKinds.includes("cron") && provision.cronExpression
      ? computeScheduleNextRun(provision.cronExpression, provision.timezone, from)
      : null;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_workspace_runtime_provisions SET next_run_at = ?, last_fired_at = ?, updated_at = ? WHERE id = ?",
      [nextRunAt, now, now, id],
    );
    return this.get(id);
  }

  recoverLostSchedules(now: Date = new Date()): number {
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_workspace_runtime_provisions
       WHERE enabled = 1 AND next_run_at IS NULL AND cron_expression IS NOT NULL
       ORDER BY id ASC`,
    ).all() as Row[];
    let recovered = 0;
    for (const row of rows) {
      const provision = toProvision(row);
      if (!provision.triggerKinds.includes("cron") || !provision.cronExpression) continue;
      const nextRunAt = computeScheduleNextRun(provision.cronExpression, provision.timezone, now);
      this.ctx.db.run(
        "UPDATE multiremi_workspace_runtime_provisions SET next_run_at = ?, updated_at = ? WHERE id = ?",
        [nextRunAt, nowIso(), provision.id],
      );
      recovered += 1;
    }
    return recovered;
  }

  recordCommandResult(request: MultiremiRuntimeCommandRequest): void {
    if (!request.provisionId) return;
    const provision = this.get(request.provisionId);
    if (!provision) return;
    let status: MultiremiRuntimeProvisionStatus = "failed";
    let observedVersion: string | null = null;
    let error = request.error;
    if (request.status === "completed" && request.exitCode === 0) {
      if (provision.kind === "npm-global") {
        observedVersion = parseProvisionObservedVersion(request.stdout);
        status = observedVersion ? "converged" : "failed";
        error = observedVersion ? null : "npm-global verification marker missing";
      } else {
        status = "converged";
        error = null;
      }
    } else if (request.status === "completed") {
      error = `command exited with code ${request.exitCode ?? "unknown"}`;
    }
    this.upsertState(provision.id, request.runtimeId, status, {
      observedVersion,
      requestId: request.id,
      checked: true,
      error,
    });
  }

  private enqueueProvisionForRuntime(provision: MultiremiWorkspaceRuntimeProvision, runtimeId: string): void {
    this.upsertState(provision.id, runtimeId, "pending", { requestId: null, checked: false, error: null });
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    if (!runtime || runtime.status !== "online") return;
    const state = this.listStates(provision.id).find((entry) => entry.runtimeId === runtimeId);
    if (state?.lastCommandRequestId) {
      const current = this.ctx.runtimes().getRuntimeCommandRequest(runtimeId, state.lastCommandRequestId);
      if (current?.status === "pending" || current?.status === "running") return;
    }
    const execution = provision.kind === "npm-global"
      ? { command: buildNpmGlobalProvisionCommand(provision), args: [], provisionKind: "npm-global" as const }
      : { command: provision.command!, args: provision.args, provisionKind: "command" as const };
    try {
      const request = this.ctx.runtimes().createRuntimeCommandRequest(runtimeId, {
        ...execution,
        timeoutMs: provision.timeoutMs,
        createdBy: provision.createdBy,
        provisionId: provision.id,
      });
      this.upsertState(provision.id, runtimeId, "pending", {
        requestId: request.id,
        checked: false,
        error: null,
      });
    } catch (error) {
      const message = redactRuntimeCommandText(error instanceof Error ? error.message : String(error));
      if (/offline/i.test(message)) return;
      this.upsertState(provision.id, runtimeId, "failed", { requestId: null, checked: true, error: message });
    }
  }

  private upsertState(
    provisionId: string,
    runtimeId: string,
    status: MultiremiRuntimeProvisionStatus,
    input: { observedVersion?: string | null; requestId: string | null; checked: boolean; error: string | null },
  ): void {
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_runtime_provision_states (
        provision_id, runtime_id, status, observed_version, last_command_request_id,
        last_checked_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provision_id, runtime_id) DO UPDATE SET
        status = excluded.status,
        observed_version = COALESCE(excluded.observed_version, multiremi_runtime_provision_states.observed_version),
        last_command_request_id = COALESCE(excluded.last_command_request_id, multiremi_runtime_provision_states.last_command_request_id),
        last_checked_at = COALESCE(excluded.last_checked_at, multiremi_runtime_provision_states.last_checked_at),
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      [
        provisionId, runtimeId, status, input.observedVersion ?? null, input.requestId,
        input.checked ? now : null, input.error ? redactRuntimeCommandText(input.error) : null, now, now,
      ],
    );
  }

  private recordAudit(
    provision: MultiremiWorkspaceRuntimeProvision,
    action: "create" | "update" | "delete",
    actorId: string | null,
  ): void {
    const snapshot = {
      kind: provision.kind,
      enabled: provision.enabled,
      package: provision.package,
      version: provision.version,
      bin: provision.bin,
      registry: provision.registry,
      command: provision.redactedCommand,
      args: provision.redactedArgs,
      trigger_kinds: provision.triggerKinds,
      cron_expression: provision.cronExpression,
      timezone: provision.timezone,
      timeout_ms: provision.timeoutMs,
    };
    this.ctx.db.run(
      `INSERT INTO multiremi_runtime_provision_audit (
        id, workspace_id, provision_id, action, snapshot, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [createId("paud"), provision.workspaceId, provision.id, action, toJson(snapshot), actorId, nowIso()],
    );
  }
}

export function buildNpmGlobalProvisionCommand(provision: MultiremiWorkspaceRuntimeProvision): string {
  if (provision.kind !== "npm-global" || !provision.package || !provision.version || !provision.bin) {
    throw new Error("invalid npm-global provision");
  }
  const registry = provision.registry ?? DEFAULT_NPM_REGISTRY;
  const packageSpec = `${provision.package}@${provision.version}`;
  const compareVersion = provision.version === "latest"
    ? "echo \"provision:already:$observed\"; exit 0"
    : `case "$observed" in *${shellQuote(provision.version)}*) echo "provision:already:$observed"; exit 0 ;; esac`;
  return [
    "set -e",
    `BIN=${shellQuote(provision.bin)}`,
    `PKG=${shellQuote(packageSpec)}`,
    `REGISTRY=${shellQuote(registry)}`,
    "if command -v \"$BIN\" >/dev/null 2>&1; then",
    "  observed=\"$(\"$BIN\" --version 2>/dev/null || echo unknown)\"",
    `  ${compareVersion}`,
    "fi",
    "npm install -g \"$PKG\" --registry=\"$REGISTRY\"",
    "command -v \"$BIN\" >/dev/null 2>&1 || { echo \"provision:verify-failed\"; exit 1; }",
    "echo \"provision:installed:$(\"$BIN\" --version 2>/dev/null || echo unknown)\"",
  ].join("\n");
}

function normalizeProvisionInput(input: CreateWorkspaceRuntimeProvisionInput) {
  const kind = String(input.kind ?? "").trim() as MultiremiRuntimeProvisionKind;
  if (kind !== "npm-global" && kind !== "command") throw new Error("kind must be npm-global or command");
  const enabled = input.enabled !== false;
  const triggerKinds = normalizeTriggerKinds(input.triggerKinds ?? input.trigger_kinds ?? ["on_register", "on_change"]);
  const cronExpression = cleanOptionalString(input.cronExpression ?? input.cron_expression);
  const timezone = cleanOptionalString(input.timezone) ?? DEFAULT_TIMEZONE;
  if (triggerKinds.includes("cron") && !cronExpression) throw new Error("cron_expression is required for cron trigger");
  if (cronExpression) computeScheduleNextRun(cronExpression, timezone);
  const args = normalizeArgs(input.args);
  if (kind === "npm-global") {
    const packageName = requiredString(input.package, "package");
    const version = requiredString(input.version, "version");
    const bin = requiredString(input.bin, "bin");
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) throw new Error("invalid npm package name");
    if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error("invalid npm package version");
    if (!/^[A-Za-z0-9._-]+$/.test(bin)) throw new Error("invalid npm binary name");
    const registry = cleanOptionalString(input.registry) ?? DEFAULT_NPM_REGISTRY;
    assertSafeRegistry(registry);
    const timeoutMs = input.timeoutMs ?? input.timeout_ms ?? MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS;
    return {
      kind, enabled, package: packageName, version, bin, registry, command: null, args: [],
      redactedCommand: null, redactedArgs: [], triggerKinds, cronExpression, timezone,
      timeoutMs: normalizeRuntimeCommandTimeout(timeoutMs, MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS),
    };
  }
  const command = requiredString(input.command, "command");
  if (Buffer.byteLength(command, "utf8") > 16 * 1024) throw new Error("command must not exceed 16384 bytes");
  if (args.length > 100) throw new Error("args must not contain more than 100 entries");
  if (args.some((arg) => Buffer.byteLength(arg, "utf8") > 8 * 1024)) {
    throw new Error("each command arg must not exceed 8192 bytes");
  }
  const timeoutMs = normalizeRuntimeCommandTimeout(input.timeoutMs ?? input.timeout_ms, MAX_RUNTIME_COMMAND_TIMEOUT_MS);
  return {
    kind, enabled, package: null, version: null, bin: null, registry: null, command, args,
    redactedCommand: redactRuntimeCommandText(command), redactedArgs: redactRuntimeCommandArgs(args),
    triggerKinds, cronExpression, timezone, timeoutMs,
  };
}

function normalizeTriggerKinds(value: unknown): MultiremiRuntimeProvisionTriggerKind[] {
  if (!Array.isArray(value)) throw new Error("trigger_kinds must be an array");
  const result = [...new Set(value.map(String))];
  if (result.some((kind) => kind !== "cron" && kind !== "on_register" && kind !== "on_change")) {
    throw new Error("trigger_kinds contains an invalid trigger");
  }
  return result as MultiremiRuntimeProvisionTriggerKind[];
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("args must be an array of strings");
  return value;
}

function requiredString(value: unknown, label: string): string {
  const clean = cleanOptionalString(value);
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}

function assertSafeRegistry(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("registry must be a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("registry must be an HTTPS URL without embedded credentials");
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseProvisionObservedVersion(stdout: string | null): string | null {
  const matches = String(stdout ?? "").matchAll(/^provision:(?:already|installed):(.+)$/gm);
  let observed: string | null = null;
  for (const match of matches) observed = match[1]?.trim() || null;
  return observed;
}

function toProvision(row: Row): MultiremiWorkspaceRuntimeProvision {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as MultiremiRuntimeProvisionKind,
    enabled: Boolean(row.enabled),
    package: nullableString(row.package),
    version: nullableString(row.version),
    bin: nullableString(row.bin),
    registry: nullableString(row.registry),
    command: nullableString(row.command),
    args: normalizeArgs(parseJson(row.args, [])),
    redactedCommand: nullableString(row.redacted_command),
    redactedArgs: normalizeArgs(parseJson(row.redacted_args, [])),
    triggerKinds: normalizeTriggerKinds(parseJson(row.trigger_kinds, [])),
    cronExpression: nullableString(row.cron_expression),
    timezone: nullableString(row.timezone),
    nextRunAt: nullableString(row.next_run_at),
    lastFiredAt: nullableString(row.last_fired_at),
    timeoutMs: Number(row.timeout_ms),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProvisionState(row: Row): MultiremiRuntimeProvisionState {
  return {
    provisionId: String(row.provision_id),
    runtimeId: String(row.runtime_id),
    status: String(row.status) as MultiremiRuntimeProvisionStatus,
    observedVersion: nullableString(row.observed_version),
    lastCommandRequestId: nullableString(row.last_command_request_id),
    lastCheckedAt: nullableString(row.last_checked_at),
    lastError: nullableString(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
