#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cliCommandInventory } from "../apps/remi/cli/index.js";
import {
  cliCoverageReport,
  type CliCapabilitiesManifest,
  validateCliCapabilities,
} from "./cli-capabilities.js";

const root = resolve(import.meta.dir, "..");
const golden = JSON.parse(readFileSync(resolve(root, "scripts/api-routes.golden.json"), "utf8")) as { routes: string[] };
const manifest = JSON.parse(readFileSync(resolve(root, "cli-capabilities.json"), "utf8")) as CliCapabilitiesManifest;
const errors = validateCliCapabilities(golden.routes, manifest, cliCommandInventory());
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const report = cliCoverageReport(manifest);
console.log(`CLI capabilities: ${report.mapped} mapped / ${report.exempt} exempt / ${report.missing} missing (${report.total} routes)`);
