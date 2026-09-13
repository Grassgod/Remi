"use client";

import { FeishuBotSection } from "./feishu-bot-section";
import { FeishuSenderAllowlistSection } from "./feishu-sender-allowlist-section";
import { LarkTab } from "./lark-tab";
import { BotMenuSection } from "./bot-menu-section";
import { IssueTopicSection } from "./issue-topic-section";

// Integrations is the umbrella tab for third-party platform connections.
// Source control has its own top-level tab; everything else lives here under
// its own section heading so additional integrations slot in without changing
// the IA.
//
// The Feishu concierge (MUL-206) leads, because it is the one bot a workspace
// actually runs: Agent, host Runtime, credentials, start/stop and status all
// live in `FeishuBotSection`. Sender authorization, Issue topic synchronization
// and the bot menu follow it because they depend on that bot being configured.
//
// `LarkTab` renders only when a workspace still has legacy per-Agent Lark
// installations to manage; it is not an entry point for new ones.
export function IntegrationsTab() {
  return (
    <div className="space-y-10">
      <FeishuBotSection />
      <FeishuSenderAllowlistSection />
      <IssueTopicSection />
      <BotMenuSection />
      <LarkTab />
    </div>
  );
}
