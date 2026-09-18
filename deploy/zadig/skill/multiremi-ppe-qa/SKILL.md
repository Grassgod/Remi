---
name: multiremi-ppe-qa
description: 使用 Zadig CLI 按 Issue 自动租用、复用、检查和释放 24 小时隔离 PPE，并在 PPE 上执行控制面或控制面加 daemon 的 QA 验收。用于需要部署分支代码、运行或排查 Zadig 工作流、查看构建与服务日志，以及将测试结论回复到 Multiremi Issue 的任务。
---

# Multiremi PPE QA

使用 Zadig CLI 管理 PPE，使用 Remi CLI 操作 Issue。不要实现 Zadig 到
Multiremi 的自动回写。

## 开始前

1. 阅读目标仓库的 `AGENTS.md`。
2. 仅检查 `ZADIG_API_TOKEN` 和 Zadig 地址是否存在，不得打印、记录或持久化 Token。
   地址键当前是 `ZADIG_API_HOST`，旧任务里可能仍是 `ZADIG_HOST`，两个都读一下取非空的那个；
   两个都缺就停下报管理员，不要猜地址，更不要退到生产控制面。
3. 使用固定版本的官方 CLI，不依赖 Runtime 是否安装全局命令：

   ```bash
   runtime_home="${HOME:?}"
   zadig_home="$(mktemp -d)"
   chmod 700 "$zadig_home"
   zadig_cli=(env HOME="$zadig_home" npm_config_cache="$runtime_home/.npm"
     npx --yes --registry=https://registry.npmjs.org
     "${ZADIG_CLI_PACKAGE:-@koderover/zadig-cli@0.1.6}")
   ```

   后续命令均使用 `"${zadig_cli[@]}"` 调用，不得使用 `latest`。
4. 在任务临时 HOME 下运行
   `"${zadig_cli[@]}" auth login --host "${ZADIG_API_HOST:-$ZADIG_HOST}" --token "$ZADIG_API_TOKEN"`，随后检查
   `auth status --output json` 和 `doctor --output json`。任务结束安全删除 `$zadig_home`。
5. 读取目标 Issue、仓库、分支、Commit 和已有 PPE 评论，避免重复部署。

## PPE 边界

- 只使用 `multiremi-ppe-1` 至 `multiremi-ppe-6` 六个固定 namespace。
- 工作流根据 `ISSUE_KEY` 原子分配空闲 slot。同一 Issue 重试会复用原租约；不要自行挑选、抢占或删除 namespace。
- 每个 PPE 自部署成功起保留 24 小时，到期由平台自动回收。TTL 是异常兜底，正常验收完成后仍应主动释放。
- 全局最多并发执行 3 条 PPE 工作流。已有 3 条在运行时等待，不得绕过并发限制。
- PPE 只承载测试数据，不得连接或复制生产 PostgreSQL、OpenViking、Secret、上传目录或 session archive。
- 不得调用生产 Platform Updater、发布正式版本、打 Tag、升级 daemon 或修改生产 Nginx。

## 选择测试模式

根据 Issue 的变更范围选择一个模式，并将模式作为工作流参数传入：

- `platform`：只部署 Multiremi 控制面。适用于页面、API、数据库迁移、鉴权和纯控制面逻辑。
- `platform-daemon`：部署控制面，并从同一个 Commit 构建和启动隔离测试 daemon。适用于 Runtime 注册、心跳、任务分派、ACP 执行、日志回传、重连和 daemon 兼容性。

无法判断时先检查变更文件和验收目标；仍不明确才在 Issue 中询问，不要默认操作生产 daemon。

`platform-daemon` 必须满足：

- 控制面与 daemon 使用同一目标 Commit，结果中分别记录两者的镜像摘要。
- 测试 daemon 只连接当前 PPE 控制面，使用独立 Runtime ID、配置目录、工作目录和临时凭证。
- 默认在当前 PPE slot 内运行 daemon；只有明确需要验证真实主机、SSH、本地 worktree 或桌面能力时，才使用工作流预先配置的专用测试 Runtime。
- 不读取生产 `~/.remi`，不复用生产 Runtime ID、SSH 私钥、插件缓存或任务目录。
- 环境释放时同时销毁测试 daemon，并确认它已从 PPE 控制面离线。

## 部署与验证

1. 使用固定版 Zadig CLI 的 JSON 输出查询项目、环境和工作流；写操作先使用
   `--dry-run`，确认目标后再带 `--yes` 执行。
2. 运行 `multiremi-ppe-deploy` 工作流，传入 `PPE_ACTION=deploy`、`PPE_SLOT=auto`、
   当前 `ISSUE_KEY`、完整 40 位 `GIT_COMMIT` 和 `PPE_MODE`。Run 文件中的工作流参数
   只保留 `name`、`type` 和 `value`；`ppe-lifecycle` Job 使用
   `{"kv":[],"repo_info":[],"services":[]}`。先 dry-run，再执行并 watch 到终态。
3. 从日志中的 `PPE_RESULT` 读取并保存 `slot`、`lease_id`、`url` 和 `expires_at`。
   即使构建失败，`provisioning` 结果也包含可用于释放环境的租约信息。不得猜测 slot。
4. 等待工作流结束。失败时读取 Zadig 工作流与 Pod 日志，修复后重试，不得转向生产环境验证。
5. `platform-daemon` 还需验证测试 Runtime 在线、任务可分派、最小任务可结束且日志可回传。
6. 只访问 `PPE_RESULT.url`。合法地址为 `http://10.37.117.209:32101` 至 `:32106`
   或同端口的 `n37-117-209.byted.org`。PPE 不启用飞书 SSO，也不得读取或传入生产
   Web Token；但**服务端无认证不等于浏览器可以免登录**——前端是 token 模式，
   `localStorage` 没有 `multimira_token` 就会直接跳 `/login`（MUL-334）。页面验收
   前先用该 PPE 自己签发的短期本地 PAT 引导登录态，再用 `$multiremi-web-qa` 在 212
   桌面执行真实浏览器验收；收尾撤销该 PAT。
7. 验证目标流程、Console Error、失败请求、健康接口和相关桌面/移动端视口。
8. 使用 Remi CLI 自行回复 Issue。按任务需要说明 PPE、Commit、测试模式、测试结论和
   Zadig 日志链接，不强制固定格式，也不复制完整日志。

## 收尾

- 最终验收完成后，运行同一工作流并传入 `PPE_ACTION=release`、原 `PPE_SLOT`、
  `ISSUE_KEY` 和 `PPE_LEASE_ID`，并确认 `PPE_RESULT.state=released`。只有用户明确要求
  保留环境时才等待 TTL 自动回收；若继续修改，重新 deploy 会复用同一 Issue 的 PPE 并续期。
- 六个 Zadig 环境记录是固定容量，不得删除。
- 关闭浏览器和临时上下文，只清理本任务创建的测试数据。
- 权限、Token、环境或工作流缺失时报告具体阻塞，不得自行扩权。

命令和故障处理细节见 [references/zadig-cli.md](references/zadig-cli.md)。
