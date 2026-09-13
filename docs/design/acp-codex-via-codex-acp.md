# Codex ACP 接入与桥接器升级

Remi 通过 [AcpProvider](../../packages/acp/src/provider.ts) 与 `codex-acp` 进行 ACP stdio 通信，由 bridge 启动其 npm 依赖中的 Codex app-server。模型、工作目录和 MCP 配置来自任务的 Agent 配置及 daemon 运行时装配；[CodexAdapter](../../packages/acp/src/adapters/codex/index.ts)负责事件显示和权限模式映射。

## 固定版本与启动

[daemon 启动入口](../../apps/remi/cli/multiremi.ts)调用 [ensureAcpBridges](../../packages/acp/src/provision.ts)，将认可的 bridge 安装到 `~/.remi/acp`。`BRIDGE_PIN.codex` 精确固定 bridge 版本；发现旧版或缺少 usage 补丁时重新安装。旧 bridge 即使已带补丁，也必须升级到新的 pin。ACP 更新请求同样安装当前 Remi 源码固定的版本，不会自动追踪 npm latest。

当前 pin 为 `@agentclientprotocol/codex-acp@1.11.0`，上游声明 `@openai/codex@^0.153.4`，本次兼容性检查基线为 Codex `0.153.4`。这个范围不包含 `0.154.0`；系统或 Homebrew 安装的 Codex 升级不会改变 bridge 默认启动的内置 CLI。桥接器提供的 `CODEX_PATH` 覆盖属于自定义执行链，不在这套固定组合验证之内。

版本升级随新的 Remi daemon 分发；仅更新平台服务或在旧 daemon 上请求 ACP 更新，不会改变该 daemon 的 pin。

## usage 补丁与协议

`codex-usage-v1` 在 bridge 的 `usage_update._meta` 中携带每次模型请求的 token 拆分，包括输入、缓存输入、输出、推理输出和总量。[provision](../../packages/acp/src/provision.ts)按发布包的代码锚点应用补丁；升级时必须重新验证锚点与字段语义。Codex prompt 结算只包含最后一次模型请求，不能替代 Remi 对整个 turn 的逐请求累加。

[AcpClient](../../packages/acp/src/client.ts)与 [AcpProvider](../../packages/acp/src/provider.ts)使用 bridge 返回的能力和配置选项协商模型、reasoning effort 与权限模式；不能用 bridge 不读取的 session `_meta` 代替协商。模型目录可见不等于真实模型请求或完整任务执行链已验证成功。

## 升级验证

使用仓库固定的 Bun 1.3.14 和公共 npm registry。在隔离目录安装待验证 bridge，不直接修改运行中的 `~/.remi/acp`。以下使用仓库已忽略的 `.remi/bridge-check`：

```bash
npm install --prefix .remi/bridge-check --registry https://registry.npmjs.org --no-audit --no-fund @agentclientprotocol/codex-acp@1.11.0
bun run verify:codex-bridge --package-dir=.remi/bridge-check/node_modules/@agentclientprotocol/codex-acp
```

[检查器](../../tests/integration/verify-codex-bridge.ts)核对发布包版本、依赖声明和实际 CLI 版本，验证补丁幂等性并执行发布包中的 token 转换，然后验证 ACP 初始化、会话创建、model/effort/权限协商和关闭。它从当前 `CODEX_HOME`（默认 `~/.codex`）复制 `auth.json` 到临时 Home，不复制本机配置；真实会话需要有效登录。

加 `--prompt` 会调用模型，要求收到指定回复和带 Remi 补丁的实际 usage 事件。不加该参数不会发送 prompt，不能将该结果记为真实模型调用通过。修改 pin 时同步核对检查器中的配套 Codex 基线；新版本若改变使用字段或协议，先适配再升级。

相关离线回归：

```bash
bun test tests/unit/acp tests/arch/lockfile-registry.test.ts
```

协议测试夹具使用 Node shebang，Windows 可在 WSL 中运行；发布包检查器通过 Node 启动 bridge，可在原生 Windows 运行。完整任务路径另用 `bun run smoke:multiremi:acp --provider=codex` 验证，需要实际模型认证前提，参见 [测试说明](../../TESTING.md)。本页列出复现方法，不声明本次检查结果。
