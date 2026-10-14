import { afterEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertNotHomeDefaultInTest, multiremiSharedLockPath, multiremiStateDir } from "@shared/home-paths.js";
import { acquireWorkspaceSupervisorLease, configuredMultiremiWorkspacesRoot } from "@daemon/agent-runtime/workspace/process-owner.js";
import { MultiremiDaemon } from "@multiremi/worker/daemon.js";

const knobs = ["NODE_ENV", "MULTIREMI_STATE_DIR", "MULTIREMI_WORKSPACES_ROOT", "MULTIREMI_TEST_RUN_ROOT"];
const previous = Object.fromEntries(knobs.map(name => [name, process.env[name]]));
afterEach(() => {
  for (const name of knobs) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

describe("home defaults under test", () => {
  const cases = [
    ["MULTIREMI_STATE_DIR", multiremiStateDir, join(homedir(), ".multiremi")],
    ["MULTIREMI_WORKSPACES_ROOT", configuredMultiremiWorkspacesRoot, join(homedir(), ".remi", "multiremi", "workspaces")],
  ] as const;

  for (const [knob, resolveRoot, productionDefault] of cases) {
    it(`rejects ${knob}'s fallback in test mode and preserves the production default`, () => {
      process.env.NODE_ENV = "test";
      delete process.env[knob];
      expect(resolveRoot).toThrow(expect.objectContaining({ code: "real_home_default_in_test" }));
      expect(resolveRoot).toThrow(knob);
      process.env.NODE_ENV = "production";
      expect(resolveRoot()).toBe(productionDefault);
    });

    it(`accepts an explicit ${knob} in test mode`, () => {
      process.env.NODE_ENV = "test";
      const root = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "explicit-root");
      process.env[knob] = root;
      expect(resolveRoot()).toBe(root);
    });
  }

  it("accepts an explicit workspace constructor root without the env knob", () => {
    delete process.env.MULTIREMI_WORKSPACES_ROOT;
    const root = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "explicit-root");
    expect(configuredMultiremiWorkspacesRoot(root)).toBe(root);
  });

  it("rejects a daemon without a workspace root when the env knob is removed", () => {
    delete process.env.MULTIREMI_WORKSPACES_ROOT;
    expect(() => new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", token: "fixture" }))
      .toThrow(expect.objectContaining({ code: "real_home_default_in_test" }));
  });

  it("the guard does nothing outside test mode", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertNotHomeDefaultInTest("FIXTURE", "pass a path")).not.toThrow();
  });

  it("preserves production shared lock paths despite a configured state directory", () => {
    process.env.NODE_ENV = "production";
    process.env.MULTIREMI_STATE_DIR = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "daemon-state");
    for (const directory of ["workspace-supervisors", "runtime-workspace-leases"]) {
      const productionPath = join("os-user-home", ".multiremi", directory);
      expect(multiremiSharedLockPath(productionPath)).toBe(productionPath);
    }
  });

  it("shares test locks independently of state directories and fails closed without a run root", () => {
    const runRoot = process.env.MULTIREMI_TEST_RUN_ROOT!;
    const productionPath = join("os-user-home", ".multiremi", "workspace-supervisors");
    for (const state of ["state-one", "state-two"]) {
      process.env.MULTIREMI_STATE_DIR = join(runRoot, state);
      expect(multiremiSharedLockPath(productionPath)).toBe(join(runRoot, "shared-locks", "workspace-supervisors"));
    }
    delete process.env.MULTIREMI_TEST_RUN_ROOT;
    expect(() => multiremiSharedLockPath(productionPath))
      .toThrow(expect.objectContaining({ code: "real_home_default_in_test" }));
    expect(() => configuredMultiremiWorkspacesRoot(join(runRoot, "explicit-workspaces"))).not.toThrow();
  });

  it("rejects a default supervisor lease without a test run root but accepts an explicit root", () => {
    const runRoot = process.env.MULTIREMI_TEST_RUN_ROOT!;
    delete process.env.MULTIREMI_TEST_RUN_ROOT;
    const workspace = join(runRoot, "guard-workspace");
    expect(() => acquireWorkspaceSupervisorLease(workspace))
      .toThrow(expect.objectContaining({ code: "real_home_default_in_test" }));
    const lease = acquireWorkspaceSupervisorLease(workspace, { stateRoot: join(runRoot, "explicit-locks") });
    lease.release();
  });
});
