import type { CommandInventoryEntry } from "../apps/remi/cli/core/command-registry.js";

export const CLI_EXEMPT_CATEGORIES = [
  "daemon_internal_protocol",
  "oauth_or_webhook_callback",
  "websocket_transport",
  "pure_ui",
  "stripe_internal_callback",
  "platform_updater_internal",
  "public_bootstrap_asset",
] as const;

export type CliExemptCategory = typeof CLI_EXEMPT_CATEGORIES[number];

export interface CliManifestCommand {
  command: string;
  aliases: string[];
  auth: string[];
  capability: string | null;
  mutation: "read" | "write" | "destructive";
  output: string[];
  hidden: boolean;
  internal?: boolean;
  migration_status?: "native" | "legacy_passthrough";
}

export interface CliManifestAlias {
  command: string;
  deprecated_since: string;
  replacement: string;
  hidden: boolean;
}

export type CliManifestRoute =
  | { command: string }
  | { planned_command: string; domain: string }
  | { cli_exempt: true; category: CliExemptCategory; reason: string };

export interface CliCapabilitiesManifest {
  schema_version: number;
  generated_from: string;
  max_planned_routes: number;
  domains: string[];
  commands: Record<string, CliManifestCommand>;
  aliases: Record<string, CliManifestAlias>;
  routes: Record<string, CliManifestRoute>;
}

export interface CliCoverageReport {
  mapped: number;
  exempt: number;
  missing: number;
  total: number;
}

export interface CliRuntimeCapabilities {
  schema_version: number;
  commands: Record<string, {
    command: string;
    auth: string[];
    capability: string;
    output: string[];
  }>;
}

export function cliCoverageReport(manifest: CliCapabilitiesManifest): CliCoverageReport {
  const routes = Object.values(manifest.routes);
  return {
    mapped: routes.filter((route) => "command" in route).length,
    exempt: routes.filter((route) => "cli_exempt" in route).length,
    missing: routes.filter((route) => "planned_command" in route).length,
    total: routes.length,
  };
}

export function cliRuntimeCapabilities(manifest: CliCapabilitiesManifest): CliRuntimeCapabilities {
  return {
    schema_version: manifest.schema_version,
    commands: Object.fromEntries(Object.entries(manifest.commands)
      .filter(([, command]) => command.capability && !command.internal)
      .map(([id, command]) => [id, {
        command: command.command,
        auth: command.auth,
        capability: command.capability!,
        output: command.output,
      }])),
  };
}

export function validateCliCapabilities(
  goldenRoutes: readonly string[],
  manifest: CliCapabilitiesManifest,
  inventory?: readonly CommandInventoryEntry[],
): string[] {
  const errors: string[] = [];
  if (manifest.schema_version !== 1) errors.push(`unsupported schema_version ${manifest.schema_version}`);
  if (manifest.generated_from !== "scripts/api-routes.golden.json") {
    errors.push("generated_from must be scripts/api-routes.golden.json");
  }
  const coverage = cliCoverageReport(manifest);
  if (!Number.isSafeInteger(manifest.max_planned_routes) || manifest.max_planned_routes < 0) {
    errors.push("max_planned_routes must be a non-negative integer");
  } else if (coverage.missing > manifest.max_planned_routes) {
    errors.push(`planned route count ${coverage.missing} exceeds ratchet ${manifest.max_planned_routes}`);
  }
  const golden = new Set(goldenRoutes);
  const routeKeys = new Set(Object.keys(manifest.routes));
  for (const route of [...golden].sort()) {
    if (!routeKeys.has(route)) errors.push(`golden route missing from manifest: ${route}`);
  }
  for (const route of [...routeKeys].sort()) {
    if (!golden.has(route)) errors.push(`manifest route missing from golden: ${route}`);
  }
  const exemptCategories = new Set<string>(CLI_EXEMPT_CATEGORIES);
  for (const [route, mapping] of Object.entries(manifest.routes)) {
    const discriminators = ["command", "planned_command", "cli_exempt"]
      .filter((field) => field in mapping);
    if (discriminators.length !== 1) {
      errors.push(`${route} must declare exactly one of command, planned_command, or cli_exempt`);
      continue;
    }
    if ("command" in mapping && !manifest.commands[mapping.command]) {
      errors.push(`${route} references unknown command ${mapping.command}`);
    }
    if ("planned_command" in mapping && (!mapping.planned_command.trim() || !mapping.domain.trim())) {
      errors.push(`${route} has an invalid planned command mapping`);
    }
    if ("planned_command" in mapping && !manifest.domains.includes(mapping.domain)) {
      errors.push(`${route} uses undeclared CLI domain ${mapping.domain}`);
    }
    if ("cli_exempt" in mapping) {
      if (mapping.cli_exempt !== true) errors.push(`${route} cli_exempt must be true`);
      if (!exemptCategories.has(mapping.category)) errors.push(`${route} has invalid exempt category ${mapping.category}`);
      if (!mapping.reason.trim()) errors.push(`${route} exempt reason is required`);
    }
  }
  for (const [id, command] of Object.entries(manifest.commands)) {
    if (!command.command.startsWith("remi ")) errors.push(`${id} command must start with remi`);
    if (!Array.isArray(command.auth) || !Array.isArray(command.output) || !Array.isArray(command.aliases)) {
      errors.push(`${id} command arrays are invalid`);
    }
  }
  for (const [path, alias] of Object.entries(manifest.aliases)) {
    if (!manifest.commands[alias.command]) errors.push(`${path} references unknown alias command ${alias.command}`);
    if (!alias.deprecated_since.trim() || !alias.replacement.trim()) errors.push(`${path} alias lifecycle is incomplete`);
  }
  if (inventory) {
    const inventoryById = new Map(inventory.map((entry) => [entry.id, entry]));
    for (const id of Object.keys(manifest.commands)) {
      if (!inventoryById.has(id)) errors.push(`manifest command missing from Registry: ${id}`);
    }
    for (const entry of inventory) {
      const command = manifest.commands[entry.id];
      if (!command) {
        errors.push(`Registry command missing from manifest: ${entry.id}`);
        continue;
      }
      const expectedPath = `remi ${entry.path.join(" ")}`;
      if (command.command !== expectedPath) errors.push(`${entry.id} path differs: ${command.command} != ${expectedPath}`);
      if (command.hidden !== entry.hidden) errors.push(`${entry.id} hidden flag differs from Registry`);
      if (command.capability !== entry.capability) errors.push(`${entry.id} capability differs from Registry`);
      if (command.mutation !== entry.mutation) errors.push(`${entry.id} mutation differs from Registry`);
      if (JSON.stringify(command.auth) !== JSON.stringify(entry.auth)) errors.push(`${entry.id} auth differs from Registry`);
      if (JSON.stringify(command.output) !== JSON.stringify(entry.outputs)) errors.push(`${entry.id} outputs differ from Registry`);
    }
  }
  return errors;
}
