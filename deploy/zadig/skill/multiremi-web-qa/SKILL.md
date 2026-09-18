---
name: multiremi-web-qa
description: 在可信 Linux 桌面环境中安全验收 Multiremi 生产页面或按 Issue 隔离的 PPE。生产环境使用 Custom Env 里的临时浏览器 PAT；209 的 32101-32106 PPE 使用该 PPE 自己签发的短期本地 PAT，不使用生产凭证。用于 UI 冒烟测试、登录态页面检查、浏览器兼容性、响应式布局、控制台与网络诊断，以及 212 桌面环境中的视觉回归测试。
---

# Multiremi 网页验收

在 `10.36.0.212` 的活动图形会话中使用全新的浏览器上下文。先识别目标是生产环境还是 PPE，再选择认证方式。

## 环境判定

- 默认生产地址为 `http://n37-117-209.byted.org`。
- 任务明确给出地址或设置 `MULTIREMI_QA_BASE_URL` 时使用该地址。
- 仅 `http://10.37.117.209:32101` 至 `:32106`，以及
  `http://n37-117-209.byted.org:32101` 至 `:32106` 属于隔离 PPE。
- 必须按规范化后的完整 Origin 精确匹配。其他地址全部按生产认证处理，不接受关闭认证的环境开关。

## 认证规则

- 生产环境从 QA Agent 的 Custom Env 读取 `MULTIREMI_QA_WEB_TOKEN`。不得打印、记录、
  持久化、截图或写入命令参数；缺失或返回 `401` 时停止并通知管理员。
- **PPE 服务端无认证，但浏览器仍然需要一个 token。** PPE 不设 `MULTIREMI_TOKEN`，
  服务端把任何请求都当本地管理员放行；可 Web 前端是 token 模式，`AuthInitializer`
  在 `localStorage` 没有 `multimira_token` 时直接判未登录并跳 `/login`，根本不会去
  问 `/api/me`。所以「PPE 免登录直接进业务页」不成立（MUL-334 已实测）。
- PPE 的登录态必须来自**该 PPE 自己签发**的短期本地 PAT，用
  `scripts/ppe-qa-session.sh login` 获取。禁止读取、转发或写入 `MULTIREMI_QA_WEB_TOKEN`
  或任何生产凭证。占位字符串只能用于纯 HTTP 页面诊断——它会让 WebSocket 持续
  `invalid token` 重连，不得作为正式验收登录态。
- 普通 SSH 不转发环境变量。跨机注入凭证时，只能通过加密的 SSH 标准输入交给 212 上的
  浏览器进程；不得放入命令参数、远端文件或 shell 历史。
- 不得运行 `env`、`printenv`、`set -x`，不得复用用户 Chromium Profile。

## 浏览器流程

1. 阅读目标仓库的 `AGENTS.md` 和现有 Playwright 配置。
2. 使用 `loginctl` 找到 212 上的活动图形会话，不硬编码 `DISPLAY` 或 `XAUTHORITY`。
3. 使用仓库已有 Playwright 版本和任务独占的临时浏览器上下文。
4. 生产模式先访问 `/login`，从 `process.env.MULTIREMI_QA_WEB_TOKEN` 写入
   `multimira_token`，再进入目标页面。
5. PPE 模式用 `scripts/ppe-qa-session.sh login "$ISSUE_KEY" "$PPE_URL" [目标路径]`
   一步完成：在该 PPE 上签发一天期本地 PAT → 经 SSH 标准输入写入该 Origin 的空
   浏览器上下文 → 打开目标页面。明文 token 不进 argv、不落文件、不进日志，状态文件
   只留 token id。收尾必须 `logout`（撤销 PAT + 关闭清理浏览器上下文）。
6. 通过页面和 `/api/me` 确认环境可用；不能仅凭没有显示登录页判断成功。PPE 还要确认
   Console 里 WebSocket 为 connected 且没有 `invalid token` 重连——那是占位 token 的
   典型症状。
7. 检查任务流程、空/加载/错误状态、Console Error、失败请求，以及相关桌面和移动端视口。

最小的环境判定必须等价于：

```ts
const baseURL = process.env.MULTIREMI_QA_BASE_URL || "http://n37-117-209.byted.org";
const origin = new URL(baseURL).origin;
const ppe = /^http:\/\/(10\.37\.117\.209|n37-117-209\.byted\.org):3210[1-6]$/.test(origin);
// 生产用 Custom Env 的 PAT；PPE 用它自己签发的短期本地 PAT。两边都要 token，
// 区别只在于凭证来源——PPE 永远拿不到、也不需要生产凭证。
const token = ppe ? mintPpeLocalToken(origin) : process.env.MULTIREMI_QA_WEB_TOKEN;
if (!ppe && !token) throw new Error("缺少 MULTIREMI_QA_WEB_TOKEN");
if (!token) throw new Error("缺少可用的浏览器登录凭证");
```

## 安全与报告

- 生产环境默认只做只读冒烟；不得直接运行会写数据库的完整 `frontend/e2e`。
- PPE 可按 Issue 验收目标创建测试数据，但不得连接生产 PostgreSQL、OpenViking、Secret、
  上传目录、Runtime 或 session archive。
- Console 和网络证据只记录 Method、脱敏 Path、Status 和错误类别，不记录 Header、Cookie、
  Authorization 或敏感 Body。
- 桌面访问失败时不得降级为 headless 后声称桌面验收通过。
- 结束时关闭本任务的浏览器上下文并删除临时目录；PPE 还要 `ppe-qa-session.sh logout`
  撤销本轮签发的本地 PAT。撤销失败时如实报告 origin 与 token id 和重试命令，不要
  当作已清理；若 PPE 已释放则凭证随环境销毁，也要写明这个判断依据。
- 报告目标 URL、Commit、认证模式、场景、结果、脱敏证据和剩余风险。
