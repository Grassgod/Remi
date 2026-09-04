import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cliCommandHelp, cliCommandInventory } from "../../../apps/remi/cli/index.js";
import { CLI_CAPABILITIES_RUNTIME } from "../../../packages/server/src/api/cli-capabilities-generated.js";
import {
  cliCoverageReport,
  cliRuntimeCapabilities,
  type CliCapabilitiesManifest,
  validateCliCapabilities,
} from "../../../scripts/cli-capabilities.js";

const root = resolve(import.meta.dir, "../../..");
const golden = JSON.parse(readFileSync(resolve(root, "scripts/api-routes.golden.json"), "utf8")) as { routes: string[] };
const manifest = JSON.parse(readFileSync(resolve(root, "cli-capabilities.json"), "utf8")) as CliCapabilitiesManifest;
const migrationDoc = readFileSync(resolve(root, "docs/cli-command-migration.md"), "utf8");

describe("CLI capabilities manifest", () => {
  it("matches golden routes in both directions and Registry commands in both directions", () => {
    expect(validateCliCapabilities(golden.routes, manifest, cliCommandInventory())).toEqual([]);
    expect(new Set(Object.keys(manifest.routes))).toEqual(new Set(golden.routes));
    expect(new Set(Object.keys(manifest.commands))).toEqual(new Set(cliCommandInventory().map((entry) => entry.id)));
  });

  it("keeps the server runtime projection synchronized with the root manifest", () => {
    const generatedRuntime: unknown = CLI_CAPABILITIES_RUNTIME;
    expect(generatedRuntime).toEqual(cliRuntimeCapabilities(manifest));
  });

  it("declares Feishu human approvals separately from task-operable message workflows", () => {
    const humanOnly = [
      "feishu.source.add",
      "feishu.source.update",
      "feishu.messages.create-issue",
      "feishu.proposals.approve",
      "feishu.proposals.reject",
    ];
    const taskOperable = [
      "feishu.source.list",
      "feishu.source.get",
      "feishu.source.status",
      "feishu.messages.list",
      "feishu.messages.resolve",
      "feishu.messages.notify",
      "feishu.messages.draft-reply",
      "feishu.messages.propose-issue",
    ];

    for (const id of humanOnly) expect(manifest.commands[id]?.auth, id).toEqual(["human"]);
    for (const id of taskOperable) expect(manifest.commands[id]?.auth, id).toEqual(["human", "task"]);
  });

  it("draws the same line on the channel-independent messaging commands", () => {
    // Wiring a workspace to a channel is a person's decision; reading what the
    // channel delivered and recording an outcome is an agent's job. The
    // refactor moved the routes, not that boundary.
    const humanOnly = [
      "messaging.connection.add",
      "messaging.connection.authorization.get",
      "messaging.connection.authorization.start",
      "messaging.connection.update",
      "messaging.connection.delete",
      "messaging.connection.check",
      "messaging.source.add",
      "messaging.source.update",
      "messaging.source.delete",
      "messaging.source.available-conversations",
      "messaging.message.create-issue",
      "messaging.proposal.approve",
      "messaging.proposal.reject",
    ];
    const taskOperable = [
      "messaging.source.status",
      "messaging.conversation.list",
      "messaging.message.list",
      "messaging.message.get",
      "messaging.message.resolve",
      "messaging.message.notify",
      "messaging.message.draft-reply",
      "messaging.message.propose-issue",
      "messaging.proposal.list",
    ];

    for (const id of humanOnly) expect(manifest.commands[id]?.auth, id).toEqual(["human"]);
    for (const id of taskOperable) expect(manifest.commands[id]?.auth, id).toEqual(["human", "task"]);
  });

  it("keeps Feishu bot menu mutations and publish status human-only", () => {
    expect(manifest.commands["workspace.bot-menu.get"]?.auth).toEqual(["human", "task"]);
    for (const command of [
      "workspace.bot-menu.update",
      "workspace.bot-menu.publish",
      "workspace.bot-menu.publish-status",
    ]) {
      expect(manifest.commands[command]?.auth).toEqual(["human"]);
    }
  });

  it("generates discoverable help for every visible Registry command and its direct children", () => {
    const inventory = cliCommandInventory();
    for (const entry of inventory.filter((candidate) => !candidate.hidden)) {
      const help = cliCommandHelp(entry.path);
      expect(help, entry.id).toContain(`Usage: remi ${entry.path.join(" ")}`);
      for (const positional of entry.positionals) {
        expect(help, `${entry.id} positional ${positional.name}`).toContain(`<${positional.name}`);
      }
      for (const option of entry.options) {
        expect(help, `${entry.id} option ${option.name}`).toContain(`--${option.name}`);
      }
      const directChildren = inventory.filter((candidate) =>
        !candidate.hidden
        && candidate.path.length === entry.path.length + 1
        && entry.path.every((segment, index) => candidate.path[index] === segment)
      );
      for (const child of directChildren) {
        expect(help, `${entry.id} -> ${child.id}`).toContain(child.path.join(" "));
      }
    }
  });

  it("declares the common parameter, renderer, auth, and confirmation contract on every capability command", () => {
    for (const entry of cliCommandInventory().filter((candidate) => candidate.capability)) {
      expect(entry.auth.length, `${entry.id} auth`).toBeGreaterThan(0);
      expect(entry.outputs, `${entry.id} outputs`).toEqual(["table", "json", "jsonl"]);
      const options = new Set(entry.options.map((option) => option.name));
      for (const name of ["output", "workspace"]) {
        expect(options.has(name), `${entry.id} --${name}`).toBe(true);
      }
      if (entry.mutation === "read") {
        for (const name of ["limit", "cursor", "query"]) {
          expect(options.has(name), `${entry.id} --${name}`).toBe(true);
        }
      }
      if (entry.mutation === "destructive" && entry.parse !== "passthrough") {
        expect(options.has("yes"), `${entry.id} --yes`).toBe(true);
      }
    }
  });

  it("maps every user route or records a justified exemption and keeps compatibility aliases", () => {
    expect(cliCoverageReport(manifest)).toEqual({
      mapped: 636,
      exempt: 87,
      missing: 0,
      total: 723,
    });
    expect(manifest.max_planned_routes).toBe(0);
    expect(cliCoverageReport(manifest).missing).toBeLessThanOrEqual(manifest.max_planned_routes);
    expect(manifest.routes["GET /api/cli/context"]).toEqual({ command: "context.get" });
    expect(manifest.routes["GET /api/cli/capabilities"]).toEqual({ command: "context.get" });
    expect(manifest.routes["GET /api/cli/latest-version"]).toEqual({
      cli_exempt: true,
      category: "platform_updater_internal",
      reason: "Dashboard-only release discovery gates the CLI update control; CLI update workflows use runtime release commands.",
    });
    expect(manifest.aliases["remi multiremi"]).toEqual({
      command: "legacy.multiremi",
      deprecated_since: "0.3.0",
      replacement: "remi <command>",
      hidden: true,
    });
    expect(manifest.aliases["remi memory recall"]).toMatchObject({
      command: "memory.search",
      replacement: "remi memory search",
    });
    expect(manifest.aliases["remi wiki history"]).toMatchObject({
      command: "wiki.revisions",
      replacement: "remi wiki revisions",
    });
    expect(manifest.aliases["remi seed"]).toMatchObject({
      command: "agent.default",
      replacement: "remi agent default",
      deprecated_since: "0.3.0",
    });
    expect(manifest.aliases["remi multiremi agent list"]).toMatchObject({
      command: "agent.list",
      replacement: "remi agent list",
      deprecated_since: "0.3.0",
    });
    expect(manifest.aliases["remi start"]).toMatchObject({
      command: "daemon.local.start",
      replacement: "remi daemon start",
      deprecated_since: "0.3.0",
    });
    expect(manifest.aliases["remi update"]).toMatchObject({
      command: "platform.local.update",
      replacement: "remi platform operation create",
      deprecated_since: "0.3.0",
    });
    expect(Object.values(manifest.routes).filter((route) => "planned_command" in route)).toEqual([]);
    expect(Object.keys(manifest.aliases)).toHaveLength(47);
    for (const [legacy, alias] of Object.entries(manifest.aliases)) {
      expect(migrationDoc, legacy).toContain(`| \`${legacy}\` | \`${alias.replacement}\` |`);
    }
  });

  it("rejects any new unmapped route after the zero-gap ratchet", () => {
    const overBudget = structuredClone(manifest);
    overBudget.routes["GET /api/runtimes"] = { planned_command: "runtime.list", domain: "runtime" };
    expect(validateCliCapabilities(golden.routes, overBudget, cliCommandInventory())).toContain(
      "planned route count 1 exceeds ratchet 0",
    );
  });
});
