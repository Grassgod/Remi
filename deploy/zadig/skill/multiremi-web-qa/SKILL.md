---
name: multiremi-web-qa
description: 在可信 Linux 桌面环境中安全验收 Multiremi 生产页面或按 Issue 隔离的 PPE。生产环境使用临时浏览器 PAT；209 的 32101-32106 PPE 使用无认证测试模式。用于 UI 冒烟测试、登录态页面检查、浏览器兼容性、响应式布局、控制台与网络诊断，以及 212 桌面环境中的视觉回归测试。
---

# Multiremi 网页验收

在 `10.36.0.212` 的活动图形会话中使用全新的浏览器上下文。先识别目标是生产环境还是 PPE，再选择认证方式。

## 环境判定

- 默认生产地址为 `http://n37-117-209.byted.org`。
- 任务明确给出地址或设置 `MULTIREMI_QA_BASE_URL` 时使用该地址。
- 仅 `http://10.37.117.209:32101` 至 `:32106`，以及
  `http://n37-117-209.byted.org:32101` 至 `:32106` 属于无认证 PPE。
- 必须按规范化后的完整 Origin 精确匹配。其他地址全部按生产认证处理，不接受关闭认证的环境开关。

## 认证规则

- 生产环境从 QA Agent 的 Custom Env 读取 `MULTIREMI_QA_WEB_TOKEN`。不得打印、记录、
  持久化、截图或写入命令参数；缺失或返回 `401` 时停止并通知管理员。
- PPE 不启用飞书 SSO。不得读取、转发或写入生产 Token，也不要添加 Header 或 Local Storage 身份。
- 普通 SSH 不转发环境变量。生产验收需要跨机时，只能通过加密的 SSH 标准输入把凭证
  临时交给 212 上的 Playwright 进程；不得放入远端文件或 shell 历史。
- 不得运行 `env`、`printenv`、`set -x`，不得复用用户 Chromium Profile。

## 浏览器流程

1. 阅读目标仓库的 `AGENTS.md` 和现有 Playwright 配置。
2. 使用 `loginctl` 找到 212 上的活动图形会话，不硬编码 `DISPLAY` 或 `XAUTHORITY`。
3. 使用仓库已有 Playwright 版本和任务独占的临时浏览器上下文。
4. 生产模式先访问 `/login`，从 `process.env.MULTIREMI_QA_WEB_TOKEN` 写入
   `multimira_token`，再进入目标页面。PPE 模式直接进入目标页面，不读取 Token。
5. 通过页面和 `/api/me` 确认环境可用；不能仅凭没有显示登录页判断成功。
6. 检查任务流程、空/加载/错误状态、Console Error、失败请求，以及相关桌面和移动端视口。

最小的环境判定必须等价于：

```ts
const baseURL = process.env.MULTIREMI_QA_BASE_URL || "http://n37-117-209.byted.org";
const origin = new URL(baseURL).origin;
const ppe = /^http:\/\/(10\.37\.117\.209|n37-117-209\.byted\.org):3210[1-6]$/.test(origin);
const token = ppe ? undefined : process.env.MULTIREMI_QA_WEB_TOKEN;
if (!ppe && !token) throw new Error("缺少 MULTIREMI_QA_WEB_TOKEN");
```

## 安全与报告

- 生产环境默认只做只读冒烟；不得直接运行会写数据库的完整 `frontend/e2e`。
- PPE 可按 Issue 验收目标创建测试数据，但不得连接生产 PostgreSQL、OpenViking、Secret、
  上传目录、Runtime 或 session archive。
- Console 和网络证据只记录 Method、脱敏 Path、Status 和错误类别，不记录 Header、Cookie、
  Authorization 或敏感 Body。
- 桌面访问失败时不得降级为 headless 后声称桌面验收通过。
- 结束时关闭本任务的浏览器上下文并删除临时目录；报告目标 URL、Commit、认证模式、
  场景、结果、脱敏证据和剩余风险。
