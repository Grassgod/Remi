import { homedir } from "node:os";
import { basename, join } from "node:path";

/** A home fallback under test means the caller omitted its isolated path. */
export function assertNotHomeDefaultInTest(knob: string, hint: string): void {
  if (process.env.NODE_ENV !== "test") return;
  throw Object.assign(new Error(`Tests must set ${knob} or ${hint} instead of using a home default`), {
    code: "real_home_default_in_test",
  });
}

export function multiremiStateDir(defaultHome = homedir()): string {
  if (process.env.MULTIREMI_STATE_DIR != null) return process.env.MULTIREMI_STATE_DIR;
  assertNotHomeDefaultInTest("MULTIREMI_STATE_DIR", "pass an explicit state/outbox path");
  return join(defaultHome, ".multiremi");
}

/** Host workspace locks must be shared across daemons with different STATE_DIRs. */
export function multiremiSharedLockPath(productionPath: string): string {
  if (process.env.NODE_ENV !== "test") return productionPath;
  const runRoot = process.env.MULTIREMI_TEST_RUN_ROOT;
  if (!runRoot?.trim()) {
    assertNotHomeDefaultInTest("MULTIREMI_TEST_RUN_ROOT", "use the hermetic test preload");
  }
  return join(runRoot!, "shared-locks", basename(productionPath));
}
