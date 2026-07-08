#!/usr/bin/env bun
/**
 * Remi CLI entry point.
 *
 * Dispatches to subcommands via apps/remi/cli/index.ts.
 * See `remi --help` for available commands.
 */

// Must be first import — swaps macOS system SQLite before any Database instance is created
import "@shared/db/sqlite-custom.js";

import { dispatch } from "./cli/index.js";

dispatch(process.argv.slice(2)).catch((e: Error) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
