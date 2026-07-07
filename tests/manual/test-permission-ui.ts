/**
 * Send 3 static cards showing permission UI designs v5.
 * Usage: bun run tests/manual/test-permission-ui.ts
 */

import { createFeishuClient } from "@connectors/feishu/client.js";
import { loadConfig } from "./_load-config.js";

async function sendCard(client: any, chatId: string, card: Record<string, unknown>, title: string) {
  await client.im.message.create({
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
  console.log(`Sent: ${title}`);
}

function makeCard(title: string, statusText: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: title },
      template: "blue",
    },
    config: { width_mode: "fill" },
    body: {
      elements: [
        { tag: "markdown", content: statusText },
        ...elements,
      ],
    },
  };
}

async function main() {
  const config = loadConfig();
  const client = createFeishuClient({ appId: config.appId, appSecret: config.appSecret, domain: config.domain as any });

  // Card 1: Tool Approval — two buttons in form
  await sendCard(client, config.chatId, makeCard(
    "Demo 1: 工具审批",
    "Waiting for approval...",
    [
      { tag: "markdown", content: "正在分析代码..." },
      { tag: "hr" },
      {
        tag: "form",
        name: "form_tool",
        elements: [
          { tag: "markdown", content: "**🔒 Bash**\n\n`$ rm -rf node_modules && bun install`" },
          {
            tag: "column_set",
            flex_mode: "none",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  name: "tool_approve",
                  text: { tag: "plain_text", content: "Allow" },
                  type: "primary",
                  form_action_type: "submit",
                }],
              },
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  name: "tool_deny",
                  text: { tag: "plain_text", content: "Deny" },
                  type: "default",
                  form_action_type: "submit",
                }],
              },
            ],
          },
        ],
      },
    ],
  ), "Tool Approval");

  await Bun.sleep(500);

  // Card 2: AskUserQuestion — select + larger input + submit
  await sendCard(client, config.chatId, makeCard(
    "Demo 2: AskUserQuestion",
    "Waiting for input...",
    [
      { tag: "markdown", content: "正在分析项目依赖..." },
      { tag: "hr" },
      {
        tag: "form",
        name: "form_ask",
        elements: [
          {
            tag: "markdown",
            content: "**项目使用哪种包管理器？**\n- **npm** — Node.js 默认\n- **yarn** — Facebook 出品\n- **pnpm** — 高效磁盘利用\n- **bun** — 速度最快",
          },
          {
            tag: "select_static",
            name: "q0",
            placeholder: { tag: "plain_text", content: "请选择..." },
            options: [
              { text: { tag: "plain_text", content: "npm" }, value: "npm" },
              { text: { tag: "plain_text", content: "yarn" }, value: "yarn" },
              { text: { tag: "plain_text", content: "pnpm" }, value: "pnpm" },
              { text: { tag: "plain_text", content: "bun" }, value: "bun" },
            ],
          },
          {
            tag: "input",
            input_type: "multiline_text",
            name: "q0_custom",
            placeholder: { tag: "plain_text", content: "或自定义回答..." },
            max_length: 500,
            rows: 3,
          },
          {
            tag: "button",
            name: "ask_submit",
            text: { tag: "plain_text", content: "Submit" },
            type: "primary",
            form_action_type: "submit",
          },
        ],
      },
    ],
  ), "AskUserQuestion");

  await Bun.sleep(500);

  // Card 3: ExitPlanMode — larger feedback input + two buttons in form
  await sendCard(client, config.chatId, makeCard(
    "Demo 3: ExitPlanMode",
    "Waiting for approval...",
    [
      { tag: "markdown", content: "分析完成，制定了实施计划：" },
      { tag: "hr" },
      {
        tag: "collapsible_panel",
        expanded: true,
        header: { title: { tag: "plain_text", content: "Implementation Plan" } },
        border: { color: "grey" },
        elements: [{
          tag: "markdown",
          content: "## 重构计划\n\n1. 拆分 config.ts 为独立模块\n2. 添加类型校验\n3. 迁移环境变量读取\n4. 补充单元测试",
        }],
      },
      {
        tag: "form",
        name: "form_plan",
        elements: [
          {
            tag: "input",
            input_type: "multiline_text",
            name: "feedback_text",
            placeholder: { tag: "plain_text", content: "反馈或修改建议（可选）..." },
            max_length: 2000,
            rows: 8,
          },
          {
            tag: "column_set",
            flex_mode: "none",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  name: "plan_approve",
                  text: { tag: "plain_text", content: "Approve" },
                  type: "primary",
                  form_action_type: "submit",
                }],
              },
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  name: "plan_reject",
                  text: { tag: "plain_text", content: "Deny" },
                  type: "default",
                  form_action_type: "submit",
                }],
              },
            ],
          },
        ],
      },
    ],
  ), "ExitPlanMode");

  console.log("\nDone!");
  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
