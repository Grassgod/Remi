import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("platform effective configuration API", () => {
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
