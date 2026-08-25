import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };

describe("workspace progress summary settings", () => {
  it("persists only allowlisted non-secret progress summary fields", async () => {
    const store = createLocalStore();
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    const response = await app.request("/api/workspaces/local", {
      method: "PATCH",
      headers: MASTER,
      body: JSON.stringify({
        settings: {
          retained_setting: "yes",
          progress_summary: {
            transport: "OPENAI",
            model: " claude-workspace ",
            openai_model: " gpt-workspace ",
            openai_api_key: "must-not-persist",
            api_key: "must-not-persist-either",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).settings).toEqual({
      retained_setting: "yes",
      progress_summary: {
        transport: "openai",
        model: "claude-workspace",
        openai_model: "gpt-workspace",
      },
    });
    expect(JSON.stringify(store.getWorkspace("local")?.settings)).not.toContain("must-not-persist");
  });
});
