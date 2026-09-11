import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("platform effective configuration API", () => {
  it("advertises the direct API origin consistently to the browser and CLI install instructions", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: "test-root-token", daemonDirectBaseUrl: "http://192.168.40.12:16120/" });
    const config = await (await app.request("/api/config")).json();
    expect(config.daemon_server_url).toBe("http://192.168.40.12:16120");
    const headers = { Authorization: "Bearer test-root-token", "Content-Type": "application/json" };
    for (const method of ["GET", "POST"]) {
      const response = await app.request("/api/multiremi/install/daemon", {
        method, headers, ...(method === "POST" ? { body: JSON.stringify({ createToken: false }) } : {}),
      });
      expect(response.status).toBe(200);
      const instructions = await response.json();
      expect(instructions.serverUrl).toBe(config.daemon_server_url);
      expect(instructions.setupCommand).toContain(config.daemon_server_url);
    }
    const explicit = await (await app.request("/api/multiremi/install/daemon?serverUrl=https://override.example.test", { headers })).json();
    expect(explicit.serverUrl).toBe("https://override.example.test");
    const legacy = createMultiremiApp({ store, authToken: "test-root-token", daemonDirectBaseUrl: null });
    expect((await (await legacy.request("/api/config")).json()).daemon_server_url).toBeUndefined();
  });
  it("requires authentication and exposes only the direct upload origin", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "test-root-token",
      daemonDirectBaseUrl: "https://api.example.test",
    });

    const unauthorized = await app.request("/api/multiremi/platform/config");
    expect(unauthorized.status).toBe(401);

    const response = await app.request("/api/multiremi/platform/config", {
      headers: { Authorization: "Bearer test-root-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      degradations: [{
        id: "session_archive_direct_upload",
        status: "enabled",
        effectiveValue: "https://api.example.test",
        detail: "Session Archive content uploads use the direct API origin",
      }],
    });
  });

  it("reports the disabled proxy fallback without exposing secrets", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "must-not-appear-in-response",
      daemonDirectBaseUrl: null,
    });

    const response = await app.request("/api/multiremi/platform/config", {
      headers: { Authorization: "Bearer must-not-appear-in-response" },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("must-not-appear-in-response");
    expect(JSON.parse(text)).toEqual({
      degradations: [{
        id: "session_archive_direct_upload",
        status: "disabled",
        effectiveValue: null,
        detail: "Session Archive direct upload disabled, falling back to 8 MiB proxy limit",
      }],
    });
  });
});
