# 飞书 concierge 配置页 PPE E2E 手册（MUL-206）

这份手册只覆盖**隔离 PPE**。生产部署需要另外的明确授权，不在本文范围内。

跑这一轮的目的是验证一件单元测试验证不了的事：真实飞书应用的凭据，从浏览器里的表单
出发，经过加密落库、heartbeat 指令、daemon 拉取，最后真的把一个 bot 连上线；以及断掉
之后能不能干净地停下来。

## 0. 开始之前

**凭据不要贴进 Issue 评论、PR 描述、聊天记录或任何命令输出。** 评论会进事件流和日志。
App Secret 只在两个地方出现：飞书开放平台的后台，和你自己浏览器里的那个输入框。

需要准备：

- 一个**专用于 PPE 的**飞书自建应用（不要复用生产 bot 的 App ID）。开放平台后台拿
  App ID / App Secret。
- 一台能连 PPE 控制面的机器，用来跑 daemon。**不要用 209**——那台机器上不允许起
  Multiremi daemon。
- PPE 控制面上一个 workspace，你在里面是 owner 或 admin。
- 至少两个 workspace 成员账号：你自己（admin），加一个普通 member。还需要一个**不是**
  该 workspace 成员的飞书账号，用来验 fail-closed 闸门。

## 1. 控制面：打开加密

配置页会读 `GET /api/workspaces/:id/feishu-bot/candidates` 里的
`encryption_available`。这个字段为 `false` 时保存按钮是禁用的——服务端没有信封加密密钥
时宁可不让存，也不会退化成明文落库。

在 PPE server 容器的环境里设置：

```bash
# 32 字节，base64。生成一次，存进 PPE 的密钥管理里，不要提交进仓库。
openssl rand -base64 32
```

```
MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=<上面那串>
```

重启 server 后打开配置页，确认保存按钮不再是禁用状态。

## 2. Runtime：起 daemon，确认能力

在那台 PPE 机器上跑 daemon。**不要**再设 `MULTIREMI_BOT_AGENT_ID`、`FEISHU_APP_ID`、
`FEISHU_APP_SECRET`——这一轮要验证的正是「不用这些环境变量也能跑起来」：

```bash
env -u MULTIREMI_BOT_AGENT_ID -u FEISHU_APP_ID -u FEISHU_APP_SECRET \
  remi start
```

在配置页的 Runtime 下拉里应该能看到这台机器，而且**不是**灰的。灰掉说明它的 heartbeat
里没有 `feishu_concierge_config_v1`，多半是二进制版本旧了。注意这里是「灰掉但仍然可见」
而不是「消失」——看不见一台自己刚起的 Runtime 比看见一台不能选的更难排查。

## 3. 主路径：手填凭据

1. `Workspace Settings → Integrations → 飞书个人机器人`。
2. 选 bot Agent（必须属于本 workspace 且未归档）、选第 2 步那台 Runtime。
3. 填 App ID、App Secret，domain 选 `feishu`。
4. 点**测试连接**。凭据对的话返回 ok；故意填错一位再点一次，应该看到一条**脱敏过的**
   错误——错误里不应该出现你填的 secret 的任何片段。
5. 保存。

保存成功后立刻检查两件事：

- 密钥输入框被清空了，页面上只剩 `cli_••••••` 这样的四位 hint。
- 打开浏览器 DevTools 的 Network，翻 `GET /api/workspaces/:id/feishu-bot` 的响应体。
  里面**不应该有** `app_secret` 这个字段，只有 `app_secret_configured` 和
  `app_secret_hint`。

## 4. 可选路径：扫码回填

点「扫码创建机器人」，用飞书扫弹出的二维码。走完之后 App ID 会自动填进表单，App Secret
显示为「已获取」但不显形。保存时前端传的是 registration session id，不是凭据本身——同样
可以在 Network 面板里确认请求体里没有 `app_secret`。

这条路是可选的。手填仍然是主路径，扫码失败不影响第 3 步。

## 5. 上线

点**启用 / 部署**。状态应该依次走过 `deploying` → `connecting` → `online`。
`deploying` 卡住不动通常是 daemon 没收到 heartbeat ack，去看 daemon 日志里有没有拉取
`GET /api/daemon/runtimes/:runtimeId/feishu-bot` 的记录。

上线后在飞书里私聊这个 bot，确认能收到 Agent 回复。

## 6. 成员闸门（fail-closed 回归）

用那个**不是** workspace 成员的飞书账号私聊 bot。预期：

- 收不到 Agent 回复。
- 控制面上**没有**新建的 Issue、没有 task、没有工具调用记录。

这条是 MUL-190 的核心安全性质，本次改动不应该动它。任何「非成员触发了一次 Agent 动作」
都是阻塞级问题。

## 7. 双 Runtime 抢占

在第二台机器上起 daemon，然后在配置页把 Runtime 切到第二台并保存。

预期是**两阶段交接**：第二台的状态先停在 `deploying`，等第一台上报 `stopped`（或它的
心跳超过 90 秒判定陈旧）之后才转 `online`。整个过程中在飞书里发消息，**只应该收到一次
回复**。收到两次说明 bot 双开了，是阻塞级问题。

把第一台 daemon 直接 kill（不给它上报 `stopped` 的机会），确认 90 秒后第二台自己转
`online`。

## 8. 菜单发布

在同一个页面编辑 bot 菜单并发布。发布应该投递给 concierge 所在的那台 Runtime。把
concierge 的 Runtime 停掉再发布一次，预期是 503 且错误信息指向「concierge 的 Runtime
不在线」——而不是悄悄发到另一台在线的机器上。

## 9. 权限

- 用普通 member 账号打开这个页面：只能看到「bot 是否可用」，看不到 App ID、Runtime
  选择、审计，也没有任何写操作按钮。
- 用 task token 直接打 `GET /api/workspaces/:id/feishu-bot`：预期 403，body 是
  `{"code": "task_token_hard_denied"}`。读也拒。
- 用 share token 打同一个接口：预期拒绝。

## 10. 停止与删除

点**停止**，确认状态回到 `stopped`，飞书里再发消息不再有回复。

删除配置，确认：connector 停了，状态回 `not_configured`，而且 DB 里那行的密文没有以任何
形式留在响应里。

## 11. 审计

打开审计列表，确认第 3、5、7、10 步的每次操作都有记录（谁、什么时候、做了什么）。审计条目
里不应该出现任何凭据片段。

## 收尾

- 停掉两台 PPE daemon。
- 在飞书开放平台后台把这个 PPE 应用的 App Secret 轮换掉——它在浏览器里被输入过，按一次性
  凭据处理。
- PPE workspace 里的配置删掉。
