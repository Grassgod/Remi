import { homedir } from "node:os";
import { join } from "node:path";

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
