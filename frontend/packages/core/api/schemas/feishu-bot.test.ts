import { describe, expect, it } from "vitest";
import type { FeishuBotRegistrationSession } from "../../types/feishu-bot";
import { parseWithFallback } from "../schema";
import {
  EMPTY_FEISHU_BOT_AVAILABILITY,
  EMPTY_FEISHU_BOT_AGENT_ROUTES,
  EMPTY_FEISHU_BOT_CANDIDATES,
  EMPTY_FEISHU_BOT_CHATS,
  EMPTY_FEISHU_BOT_CONFIG,
  EMPTY_FEISHU_BOT_STATUS,
  FeishuBotAvailabilitySchema,
  FeishuBotAgentRoutesSchema,
  FeishuBotCandidatesSchema,
  FeishuBotChatsSchema,
  FeishuBotConfigSchema,
  FeishuBotRegistrationSessionSchema,
  FeishuBotStatusSchema,
  FeishuBotTestResultSchema,
  IssueTopicConfigResponseSchema,
} from "./feishu-bot";

const CONFIG_ENDPOINT = { endpoint: "GET /api/workspaces/:id/feishu-bot" };
const STATUS_ENDPOINT = { endpoint: "GET /api/workspaces/:id/feishu-bot/status" };

describe("Issue notification recipient schema", () => {
  it("defaults omitted policies and fails closed on future or malformed policies", () => {
    expect(IssueTopicConfigResponseSchema.parse({ config: {} }).config.notify_mode).toBe("group_owner");
    for (const mode of ["all", null, 42]) {
      const config = IssueTopicConfigResponseSchema.parse({ config: { notify_mode: mode, notify_open_id: [] } }).config;
      expect(config.notify_mode).toBe("none");
      expect(config.notify_open_id).toBeNull();
    }
  });

  it("preserves an explicit bot-scoped recipient", () => {
    expect(IssueTopicConfigResponseSchema.parse({ config: { notify_mode: "person", notify_open_id: "ou_reviewer" } }).config)
      .toMatchObject({ notify_mode: "person", notify_open_id: "ou_reviewer" });
  });
});

describe("FeishuBotConfigSchema", () => {
  it("defaults every field a sparse server omits, without throwing", () => {
    const result = parseWithFallback(
      { configured: true, workspace_id: "ws_1", app_id: "cli_abc" },
      FeishuBotConfigSchema,
      EMPTY_FEISHU_BOT_CONFIG,
      CONFIG_ENDPOINT,
    );
    expect(result.configured).toBe(true);
    expect(result.app_id).toBe("cli_abc");
    expect(result.agent_id).toBeNull();
    expect(result.domain).toBe("feishu");
    expect(result.revision).toBe(0);
    expect(result.app_secret_configured).toBe(false);
  });

  it("falls back to an unconfigured bot when the payload is the wrong shape", () => {
    const result = parseWithFallback(
      { configured: "yes", revision: "seven", agent_id: 12 },
      FeishuBotConfigSchema,
      EMPTY_FEISHU_BOT_CONFIG,
      CONFIG_ENDPOINT,
    );
    // Degrading toward "nothing is configured" is the safe direction: the page
    // offers to set the bot up instead of claiming one exists.
    expect(result).toEqual(EMPTY_FEISHU_BOT_CONFIG);
  });

  it("keeps an unknown domain rather than dropping the whole response", () => {
    const result = parseWithFallback(
      { configured: true, app_id: "cli_abc", domain: "some_new_region" },
      FeishuBotConfigSchema,
      EMPTY_FEISHU_BOT_CONFIG,
      CONFIG_ENDPOINT,
    );
    expect(result.domain).toBe("some_new_region");
  });

  it("never invents a secret when the server sends none", () => {
    const result = parseWithFallback(
      { configured: true, app_id: "cli_abc", app_secret_configured: true },
      FeishuBotConfigSchema,
      EMPTY_FEISHU_BOT_CONFIG,
      CONFIG_ENDPOINT,
    );
    expect(result.app_secret_configured).toBe(true);
    expect(result.app_secret_hint).toBeNull();
    expect("app_secret" in result).toBe(false);
  });
});

describe("FeishuBotAvailabilitySchema", () => {
  it("reads the member projection", () => {
    const result = parseWithFallback(
      { configured: true, available: true, bot_name: "Remi" },
      FeishuBotAvailabilitySchema,
      EMPTY_FEISHU_BOT_AVAILABILITY,
      CONFIG_ENDPOINT,
    );
    expect(result).toEqual({ configured: true, available: true, bot_name: "Remi" });
  });

  it("falls back to unavailable when `available` is not a boolean", () => {
    const result = parseWithFallback(
      { configured: true, available: "true", bot_name: null },
      FeishuBotAvailabilitySchema,
      EMPTY_FEISHU_BOT_AVAILABILITY,
      CONFIG_ENDPOINT,
    );
    expect(result.available).toBe(false);
  });
});

describe("FeishuBotStatusSchema", () => {
  it("passes an unknown status string through for the UI's default branch", () => {
    const result = parseWithFallback(
      { status: "quarantined", workspace_id: "ws_1", revision: 3 },
      FeishuBotStatusSchema,
      EMPTY_FEISHU_BOT_STATUS,
      STATUS_ENDPOINT,
    );
    expect(result.status).toBe("quarantined");
    expect(result.stale_runtime_ids).toEqual([]);
  });

  it("falls back when `stale_runtime_ids` arrives as null instead of an array", () => {
    const result = parseWithFallback(
      { status: "online", stale_runtime_ids: null },
      FeishuBotStatusSchema,
      EMPTY_FEISHU_BOT_STATUS,
      STATUS_ENDPOINT,
    );
    // A null array used to be enough to crash the takeover notice; the fallback
    // reports `not_configured`, which is strictly safer than a false "online".
    expect(result).toEqual(EMPTY_FEISHU_BOT_STATUS);
  });
});

describe("FeishuBotCandidatesSchema", () => {
  it("keeps the pickers empty when the arrays drift", () => {
    const result = parseWithFallback(
      { workspace_id: "ws_1", agents: "none", runtimes: [] },
      FeishuBotCandidatesSchema,
      EMPTY_FEISHU_BOT_CANDIDATES,
      { endpoint: "GET /api/workspaces/:id/feishu-bot/candidates" },
    );
    expect(result).toEqual(EMPTY_FEISHU_BOT_CANDIDATES);
    expect(result.encryption_available).toBe(false);
  });

  it("defaults a runtime that does not report its capability to unsupported", () => {
    const result = parseWithFallback(
      {
        workspace_id: "ws_1",
        agents: [{ id: "agt_1" }],
        runtimes: [{ id: "rt_1", name: "mac-mini", online: true }],
        encryption_available: true,
      },
      FeishuBotCandidatesSchema,
      EMPTY_FEISHU_BOT_CANDIDATES,
      { endpoint: "GET /api/workspaces/:id/feishu-bot/candidates" },
    );
    // An older daemon says nothing about `feishu_concierge_config_v1`; treating
    // silence as "supported" would let an admin pick a Runtime that can never
    // apply the config.
    expect(result.runtimes[0]?.supports_config).toBe(false);
    expect(result.agents[0]?.name).toBe("");
  });
});

describe("FeishuBotAgentRoutesSchema", () => {
  it("preserves archived route metadata for a visible fallback warning", () => {
    const result = parseWithFallback({
      workspace_id: "ws_1",
      routes: [{
        id: "route_1",
        scope: "chat",
        chat_id: "oc_issue",
        agent_id: "agt_archived",
        agent_name: "Old Agent",
        agent_archived: true,
      }],
    }, FeishuBotAgentRoutesSchema, EMPTY_FEISHU_BOT_AGENT_ROUTES, {
      endpoint: "GET /api/workspaces/:id/feishu-bot/routes",
    });
    expect(result.routes[0]).toMatchObject({
      chat_id: "oc_issue",
      member_count: null,
      agent_archived: true,
    });
  });

  it("falls back to no routes when the route array is null", () => {
    const result = parseWithFallback(
      { workspace_id: "ws_1", routes: null },
      FeishuBotAgentRoutesSchema,
      EMPTY_FEISHU_BOT_AGENT_ROUTES,
      { endpoint: "GET /api/workspaces/:id/feishu-bot/routes" },
    );
    expect(result).toEqual(EMPTY_FEISHU_BOT_AGENT_ROUTES);
  });
});

describe("FeishuBotChatsSchema", () => {
  it("defaults optional chat metadata", () => {
    const result = parseWithFallback(
      { workspace_id: "ws_1", chats: [{ chat_id: "oc_1", name: "Team" }] },
      FeishuBotChatsSchema,
      EMPTY_FEISHU_BOT_CHATS,
      { endpoint: "GET /api/workspaces/:id/feishu-bot/chats" },
    );
    expect(result.chats[0]).toEqual({
      chat_id: "oc_1",
      name: "Team",
      member_count: null,
      chat_mode: null,
    });
  });

  it("falls back to an empty directory when chats has the wrong type", () => {
    const result = parseWithFallback(
      { workspace_id: "ws_1", chats: "none" },
      FeishuBotChatsSchema,
      EMPTY_FEISHU_BOT_CHATS,
      { endpoint: "GET /api/workspaces/:id/feishu-bot/chats" },
    );
    expect(result).toEqual(EMPTY_FEISHU_BOT_CHATS);
  });
});

describe("FeishuBotTestResultSchema", () => {
  it("reads a failure without an error code as not-ok", () => {
    const result = parseWithFallback(
      { ok: false, error_message: "app secret rejected" },
      FeishuBotTestResultSchema,
      { ok: false, error_code: null, error_message: null },
      { endpoint: "POST /api/workspaces/:id/feishu-bot/test" },
    );
    expect(result.ok).toBe(false);
    expect(result.error_code).toBeNull();
    expect(result.error_message).toBe("app secret rejected");
  });
});

describe("FeishuBotRegistrationSessionSchema", () => {
  it("defaults the poll interval so a drifted session cannot spin the dialog", () => {
    // The fallback has to be a whole session: parseWithFallback infers its
    // return type from this argument, so a partial one would hide the very
    // fields this test is checking the schema fills in.
    const fallback: FeishuBotRegistrationSession = {
      session_id: "",
      status: "error",
      verification_uri: "",
      user_code: "",
      expires_at: "",
      poll_interval_seconds: 5,
      app_id: null,
      app_secret_available: false,
      created_by_open_id: null,
      error_message: null,
    };
    const result = parseWithFallback(
      { session_id: "reg_1", status: "pending", verification_uri: "https://example.test/qr" },
      FeishuBotRegistrationSessionSchema,
      fallback,
      { endpoint: "POST /api/workspaces/:id/feishu-bot/registration" },
    );
    expect(result.poll_interval_seconds).toBe(5);
    expect(result.app_secret_available).toBe(false);
    expect(result.app_id).toBeNull();
  });
});
