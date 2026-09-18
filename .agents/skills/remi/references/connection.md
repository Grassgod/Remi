# 连接、身份与 JSON

## 选择目标

API 命令的连接值通常按显式参数、进程环境、保存的 CLI 配置解析。使用用户指定的 **API 地址**，不要把 Web 页面端口、Runtime 本机控制端口或监听地址 `0.0.0.0` 当作服务器地址。

```sh
remi --version
remi context --server <api-url> --workspace <workspace-id> --json
remi workspace list --json
```

后续每条命令保留相同的 `--server` / `--workspace`，或在当前执行进程设置 `MULTIREMI_SERVER_URL` / `MULTIREMI_WORKSPACE_ID`。不要只给第一条查询传目标参数，随后把写入发向保存的默认实例。请求 JSON 不应夹带另一个 `workspace_id` / `workspaceId`。

`remi context` 返回 `identity`、`workspace`、`current`、`allowed_operations` 和 `capabilities`。human 身份仍受成员角色与资源归属约束；task、daemon、share 不是管理员的替代身份。在云友任务里保留平台注入的身份与上下文。

需要人类登录时，使用用户提供的登录信息。密码登录支持 JSON 文件或 stdin，并保存 CLI 会话：

```sh
remi context auth password --server <api-url> --workspace <workspace-id> --file <private-login.json> --json
```

请求字段是 `email`、`password`。使用已有 token 时，可只在命令的子进程环境中提供 `MULTIREMI_TOKEN`。需要隔离保存配置时，`MULTIREMI_CONFIG` 指向独立配置文件。不要读取其他用途的私钥或服务器签名密钥来构造登录身份。

## 结构化输入和输出

`--json` 选择输出格式；`--file path` / `--file -` 提供 JSON 请求体。支持哪些字段要核对具体命令，二者不能混为一谈。多行 instructions 和嵌套 JSON 优先用文件，不在命令行里堆转义字符。

PowerShell 示例，假设连接环境已经设置：

```powershell
$agentId = '<agent-id>'
$agentPatch = @{
  description = '检查构建与测试结果'
  instructions = Get-Content -Raw -LiteralPath '.\agent-instructions.md'
}
$payloadPath = Join-Path ([System.IO.Path]::GetTempPath()) ('remi-agent-' + [guid]::NewGuid() + '.json')
try {
  [System.IO.File]::WriteAllText($payloadPath, ($agentPatch | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
  & remi agent update $agentId --file $payloadPath --json
  if ($LASTEXITCODE -ne 0) { throw 'Remi 配置写入失败' }
} finally {
  Remove-Item -LiteralPath $payloadPath -ErrorAction SilentlyContinue
}
```

此例只写非敏感指令。凭据文件使用用户受限目录；不要假设系统临时目录自动满足凭据的权限要求。在 Bash 中可用 `remi ... --file - < payload.json`；PowerShell 不使用这种 stdin 重定向语法。

解析 JSON 时只读 stdout，stderr 单独收集，不用 `2>&1` 合并。检查进程退出码后再解析；失败时避免把可能带有请求数据的原始异常完整贴进报告。少数旧入口不提供 Registry 的 JSON 契约，先核对帮助，不给它们强加通用选项。

## 排查次序

连接失败先核对 API 地址与进程环境；401 核对会话是否有效；403 核对当前身份和资源工作区；404 核对真实 ID 与工作区。升级或更换身份不是自动重试手段。未知命令、未知字段或能力不支持时，重新读取当前帮助和错误，不悄悄改用数据库或猜测的 HTTP 请求。
