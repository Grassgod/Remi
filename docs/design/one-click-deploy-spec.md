# Remi 一键部署 — 需求规格书

> 版本: v1.0 | 日期: 2026-03-23 | 状态: 已确认

## 1. 产品定位

| 项 | 内容 |
|---|---|
| 产品名 | **Remi** |
| 目标用户 | 近期：字节同事；远期：开源社区 |
| 平台 | Linux + macOS |
| 分发方式 | 闭源（混淆 + 加密 JS bundle），GitHub Releases |
| 实例模型 | 单实例（一人一套飞书 Bot + 一个 Remi） |

## 2. 安装入口

```bash
curl -fsSL https://github.com/grasscoder/remi/releases/latest/download/install.sh | bash
```

### install.sh 职责

1. 检测 OS（Linux / macOS）和架构（x86_64 / arm64）
2. 安装 Bun（如未安装）
3. 安装 PM2（如未安装）
4. 安装 Claude Code CLI（如未安装）
5. 从 GitHub Releases 下载加密混淆后的 bundle
6. 解压到 `~/.remi/` 下（代码、核心 skills、agents）
7. 生成默认 `~/.remi/remi.toml` 配置模板
8. 将 `remi` 命令链接到 PATH
9. 运行 `remi doctor` 首次自检
10. 引导用户进入 `remi login` 配置流程

## 3. CLI 命令集

| 命令 | 功能 |
|------|------|
| `remi start` | PM2 拉起所有服务（Remi 主进程 + Dashboard + 配置的 services） |
| `remi stop` | PM2 停止所有服务 |
| `remi restart` | PM2 重启所有服务（等价于 stop + start） |
| `remi status` | 显示各进程运行状态、端口、内存、uptime |
| `remi doctor` | 全量自检（见第 5 节） |
| `remi update` | 从 GitHub Releases 拉最新 bundle，覆盖代码，保留个人数据 |
| `remi login` | 分步交互式引导（见第 4 节） |

## 4. `remi login` 流程

分步引导，每步可跳过（除标注"必填"外）：

| 步骤 | 内容 | 必填？ |
|------|------|--------|
| 1 | **Claude Code 登录** — 调用 `claude login` | 是 |
| 2 | **飞书 Bot 自动创建** — 调用飞书 App Registration API（Device Flow），扫码即创建 Bot 并获取 app_id / app_secret，自动写入 remi.toml | 是 |
| 3 | **飞书权限检测** — 自动检查权限点是否配齐（长连接模式，无需回调地址） | 自动 |
| 4 | **飞书 User OAuth** — Device Authorization Flow 获取 user_access_token | 是 |
| 5 | **Gemini API Key** — 图片生成能力 | 否 |
| 6 | **Embedding API Key** — 向量搜索能力 | 否 |

**可选项的降级策略：** 运行时不报错，功能不可用时提示用户补充配置即可。

### 飞书 Bot 自动创建（核心亮点）

基于飞书 App Registration API（公开可用，外网可达），实现扫码一键创建 Bot：

**API 端点：**
```
POST https://accounts.feishu.cn/oauth/v1/app/registration
```

**流程：**
1. `init` — 获取 nonce（会话令牌）
2. `begin` — 获取 device_code + user_code + 二维码链接（`https://open.feishu.cn/page/openclaw?user_code=XXXX`）
3. 终端显示二维码 / 打印链接，用户飞书扫码确认
4. `poll` — 轮询获取 app_id + app_secret
5. 自动写入 remi.toml + 验证连通性

**参考实现：** bytedcli (`@bytedance-dev/bytedcli`) 的 `feishu login` 命令，源自 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)（MIT 协议）。

**默认权限（~65 个 scope）：** 包含 base、calendar、task、document、sheet、wiki、chat 等常用权限，安装时自动申请。

**兼容性：** feishu.cn（飞书）和 larksuite.com（Lark 国际版）均支持。

## 5. `remi doctor` 自检

### 检查维度

| 维度 | 检查项 |
|------|--------|
| **运行时** | Bun 版本 ≥ 要求、PM2 已安装、Claude CLI 已安装且可用 |
| **配置** | remi.toml 存在、必填字段完整（feishu.app_id + app_secret 即可） |
| **认证** | Claude 登录状态、飞书 token 有效性、可选 API key 状态（标注缺失但不报错） |
| **服务** | PM2 各进程运行状态、端口占用检测 |
| **网络** | 飞书 API 可达性、Claude API 可达性 |
| **存储** | ~/.remi/ 目录权限、SQLite 可读写 |
| **Skills** | 核心 skills 文件完整性校验 |

### 触发时机

- 安装完成后自动执行一次
- `remi start` 启动前自动执行
- 用户手动执行 `remi doctor`

### 输出格式

```
Remi Doctor v0.1.0
──────────────────────────
Runtime
  ✅ Bun 1.2.x
  ✅ PM2 5.x
  ✅ Claude CLI 1.x

Config
  ✅ remi.toml found
  ✅ feishu.app_id configured
  ✅ feishu.app_secret configured

Auth
  ✅ Claude logged in
  ✅ Feishu token valid (expires in 28d)
  ⚠️  Gemini API Key not configured (image generation disabled)
  ⚠️  Embedding API Key not configured (vector search disabled)

Services
  ✅ remi (pid: 12345, port: 9000)
  ✅ dashboard (pid: 12346, port: 6120)

Network
  ✅ Feishu API reachable
  ✅ Claude API reachable

Storage
  ✅ ~/.remi/ writable
  ✅ SQLite OK

Skills
  ✅ 8/8 core skills intact

──────────────────────────
Result: 2 warnings, 0 errors
💡 Run `remi login` to configure optional API keys
```

## 6. Skills 分类

| 分类 | Skills | 说明 |
|------|--------|------|
| **核心（打包）** | image, skill-creator, memory-enhance, agent-browser | 用户直接使用的基础能力 |
| **核心 Agents（打包）** | memory-extract, memory-rerank, wiki-curate, memory-audit | 后台记忆维护系统 |
| **可选（用户自装）** | bytedance-tools | 字节内部工具，需 bytedcli + 内网环境 |
| **不打包** | ai-daily-briefing, feishu-insight, memory-research, authorize-doc, larkparser-logid, browser-sso, frontend-design, brand-guidelines, theme-factory, web-artifacts-builder, webapp-testing, mcp-builder | 特定场景 / 开发工具，不属于产品核心 |

## 7. 闭源打包方案

### 构建流程

```
源码 (TypeScript)
  → bun build / esbuild (bundle)
  → javascript-obfuscator (混淆)
  → tar.gz (按平台打包)
  → GitHub Releases (发布)
```

### 打包内容

| 包含 | 不包含 |
|------|--------|
| 混淆后的 JS bundle（核心代码） | ~/.remi/memory/（用户记忆数据） |
| 核心 Skills（8 个，明文 Markdown） | ~/.remi/auth/（token 数据） |
| Background Agents（4 个） | bytedance-tools skill |
| package.json（依赖声明） | 其他非核心 skills |
| remi.toml 配置模板 | |
| install.sh | |

## 8. `remi update` 策略

1. 检查 GitHub Releases 最新版本 vs 本地版本
2. 下载新 bundle
3. 备份当前代码目录（`~/.remi/dist.bak/`）
4. 覆盖：代码 bundle、核心 skills、agents、package.json
5. 保留：`remi.toml`, `memory/`, `auth/`, `sessions.json`, `queue/`, `logs/`, `traces/`
6. 运行 `bun install`（如依赖有变更）
7. 运行 `remi doctor` 验证
8. 提示用户 `remi start` 重启

## 9. 部署后目录结构

```
~/.remi/
├── bin/
│   └── remi                  ← CLI 入口（链接到 PATH）
├── dist/
│   └── remi.bundle.js        ← 混淆后的核心代码
├── skills/                   ← 核心 Skills（8 个）
│   ├── image/
│   ├── skill-creator/
│   ├── memory-enhance/
│   └── agent-browser/
├── agents/                   ← 后台 Agents（4 个）
│   ├── memory-extract/
│   ├── memory-rerank/
│   ├── wiki-curate/
│   └── memory-audit/
├── node_modules/             ← 依赖
├── package.json
├── remi.toml                 ← 用户配置（安装时生成模板）
├── ecosystem.config.cjs      ← PM2 配置（运行时自动生成）
├── memory/                   ← 记忆数据（用户的，update 保留）
├── auth/                     ← Token 数据（用户的，update 保留）
├── logs/                     ← 日志（update 保留）
├── traces/                   ← Tracing（update 保留）
├── queue/                    ← BunQueue 数据（update 保留）
└── sessions.json             ← 会话映射（update 保留）
```

## 10. 开放问题（后续迭代）

| 问题 | 备注 |
|------|------|
| MCP server 配置 | remi-lark 等 MCP server 的安装和配置如何随主包自动化 |
| Skills 市场 | 远期支持 `remi install-skill xxx` 从社区安装 skills |
| 多平台 connector | 目前仅飞书，后续可能需要 Slack / Discord 等 |
| 自动更新 | 是否需要 `remi update --auto` 定时检查新版本 |
| 配置迁移 | 版本升级导致 remi.toml 格式变更时的自动迁移 |
