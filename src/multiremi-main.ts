#!/usr/bin/env bun
/**
 * Standalone Multiremi CLI entry point.
 *
 * This is the release binary entry for the native Bun/TypeScript Multiremi
 * subsystem. The Remi monolith still exposes the same commands through
 * `remi multiremi`, but release artifacts should install this as `multiremi`.
 */

// Must be first import -- swaps macOS system SQLite before any Database instance is created.
import "./shared/db/sqlite-custom.js";

import { runMultiremi } from "./cli/multiremi.js";

runMultiremi(process.argv.slice(2), { programName: "multiremi" }).catch((e: Error) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
