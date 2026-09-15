import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { FeishuBotSenderProfiles } from "@multiremi/feishu-bot/sender-profiles.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

function fixture() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Bot", provider: "codex", workspaceId: "local" });
  store.registerRuntime({ id: "rt_profile", name: "Bot", provider: "codex", workspaceId: "local", daemonId: "profile" });
  store.heartbeatRuntime("rt_profile", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", { agentId: agent.id, runtimeId: "rt_profile",
    appId: "cli_profile", domain: "feishu", enabled: true, appSecretOp: "set", appSecret: "test-profile-secret" });
  store.submitFeishuBotMessage("local", "rt_profile", { revision: config.revision,
    externalSessionKey: "oc_profile", externalMessageId: "om_profile", senderOpenId: "ou_profile", text: "Hello" });
  const sender = store.listFeishuBotSenders("local")[0]!;
  return { store, sender, config, agent };
}

function profileFetch(items: unknown[]) {
  return mock(async (url: string | URL | Request) => {
    if (String(url).includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "test-token" });
    return Response.json({ code: 0, data: { items } });
  });
}
const namedMessage = { message_id: "om_profile", sender: { id: "ou_profile", id_type: "open_id", sender_type: "user",
  sender_name: "陈测试", sender_i18n_names: { en_us: "Test Chen", zh_cn: "陈测试" } } };

describe("Feishu sender message profiles", () => {
  it("backfills names in one batch, coalesces reads and preserves the allowlist and message timestamps", async () => {
    const { store, sender } = fixture();
    store.setFeishuBotSenderAllowed("local", sender.id, true, "local");
    const fetchImpl = profileFetch([namedMessage]);
    const profiles = new FeishuBotSenderProfiles(fetchImpl as unknown as typeof fetch);
    await Promise.all([profiles.refresh(store, "local"), profiles.refresh(store, "local")]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("with_sender_name=true");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("message_ids=om_profile");
    expect(store.listFeishuBotSenders("local")[0]).toMatchObject({ ...sender,
      display_name: "陈测试", name_en: "Test Chen", allowed: true });
    await profiles.refresh(store, "local");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not trust an unrelated message, sender identity or sender type", async () => {
    const { store, sender } = fixture();
    const fetchImpl = profileFetch([
      { ...namedMessage, message_id: "om_unrelated" },
      { ...namedMessage, sender: { ...namedMessage.sender, id: "ou_other" } },
      { ...namedMessage, sender: { ...namedMessage.sender, sender_type: "app" } },
    ]);
    await new FeishuBotSenderProfiles(fetchImpl as unknown as typeof fetch).refresh(store, "local");
    expect(store.listFeishuBotSenders("local")[0]).toEqual(sender);
  });

  it("keeps known names on lookup failures and throttles failed lookups", async () => {
    const { store, sender } = fixture();
    store.updateFeishuBotSenderProfile("local", sender.app_id, sender.id,
      { name: "Known Name", nameEn: "Known English" }, "2000-01-01T00:00:00Z");
    const failing = mock(async () => { throw new Error("network unavailable"); });
    const profiles = new FeishuBotSenderProfiles(failing as unknown as typeof fetch);
    await profiles.refresh(store, "local");
    await profiles.refresh(store, "local");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(store.listFeishuBotSenders("local")[0]).toMatchObject({
      display_name: "Known Name", name_en: "Known English", allowed: false });
  });

  it("refuses stale application results and refreshes expired profiles", async () => {
    const { store, sender, config, agent } = fixture();
    const profiles = new FeishuBotSenderProfiles(profileFetch([namedMessage]) as unknown as typeof fetch);
    await profiles.refresh(store, "local");
    db!.run("UPDATE multiremi_feishu_bot_senders SET profile_checked_at = '2000-01-01' WHERE id = ?", [sender.id]);
    expect(store.listFeishuBotSenderProfileSources("local", new Date().toISOString())).toHaveLength(1);
    store.upsertFeishuBotConfig("local", { agentId: agent.id, runtimeId: "rt_profile", appId: "cli_replacement",
      domain: "feishu", enabled: true, appSecretOp: "set", appSecret: "test-replacement" });
    store.updateFeishuBotSenderProfile("local", config.appId, sender.id, { name: "Wrong", nameEn: null }, new Date().toISOString());
    expect(db!.query("SELECT display_name FROM multiremi_feishu_bot_senders WHERE id = ?").get(sender.id))
      .toEqual({ display_name: "陈测试" });
  });
});
