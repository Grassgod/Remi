import type { MultiremiStore } from "@multiremi/store.js";

export function configureKindBot(store: MultiremiStore, workspaceId = "local", runtimeId = "rt_kinds") {
  const agent = store.createAgent({ name: "Kind bot", provider: "codex", workspaceId });
  store.registerRuntime({ id: runtimeId, name: "Kind host", provider: "codex", workspaceId, daemonId: `daemon_${runtimeId}` });
  store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig(workspaceId, { agentId: agent.id, runtimeId,
    appId: "cli_kind_test", appSecretOp: "set", appSecret: "local-fake-channel-secret", domain: "feishu", enabled: true });
  store.reportFeishuBotRuntimeStatus(workspaceId, runtimeId, { appliedRevision: config.revision, state: "online" });
  const inbound = (suffix: string) => {
    const result = store.submitFeishuBotMessage(workspaceId, runtimeId, {
    revision: config.revision, externalSessionKey: `oc_kind_${suffix}`, chatType: "p2p", chatId: `oc_kind_${suffix}`,
    externalMessageId: `om_kind_${suffix}`, senderOpenId: "ou_kind_sender", text: "Answer", deliveryMode: "native_cot_v1",
    });
    const claimed = store.claimTask(runtimeId);
    if (claimed?.id === result.taskId) store.startTask(result.taskId);
    else if (claimed) throw new Error("Kind fixture dispatched an unrelated Task");
    return result;
  };
  return { store, agent, config, inbound, workspaceId, runtimeId };
}
