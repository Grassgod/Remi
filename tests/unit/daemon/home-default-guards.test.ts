import { afterEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertNotHomeDefaultInTest, multiremiStateDir } from "@shared/home-paths.js";
import { configuredMultiremiWorkspacesRoot } from "@daemon/agent-runtime/workspace/process-owner.js";
import { SessionArchiveService, sessionArchiveStorageConfigFromEnv } from "@multiremi/session-archive/service.js";
import { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

const knobs = ["NODE_ENV", "MULTIREMI_STATE_DIR", "MULTIREMI_WORKSPACES_ROOT", "MULTIREMI_SESSION_ARCHIVE_ROOT"];
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
    ["MULTIREMI_SESSION_ARCHIVE_ROOT", () => sessionArchiveStorageConfigFromEnv().root,
      resolve(homedir(), ".remi", "multiremi", "session-archives")],
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
      expect(resolveRoot()).toBe(resolveRoot === multiremiStateDir ? root : resolve(root));
    });
  }

  it("accepts explicit workspace and archive constructor roots without env knobs", () => {
    delete process.env.MULTIREMI_WORKSPACES_ROOT;
    delete process.env.MULTIREMI_SESSION_ARCHIVE_ROOT;
    const root = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "explicit-root");
    expect(configuredMultiremiWorkspacesRoot(root)).toBe(root);
    expect(sessionArchiveStorageConfigFromEnv(root).root).toBe(resolve(root));
    const service = new SessionArchiveService({} as MultiremiStore, { root });
    expect(service.rootHint()).toBe(join("...", "explicit-root"));
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

  it("preserves the supervisor's OS user home fallback", () => {
    process.env.NODE_ENV = "production";
    delete process.env.MULTIREMI_STATE_DIR;
    const userHome = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "os-user-home");
    expect(multiremiStateDir(userHome)).toBe(join(userHome, ".multiremi"));
  });
});
