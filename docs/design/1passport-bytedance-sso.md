---
title: 1Passport 与外部 SSO 接入边界
status: active
summary: 定位本地 AuthStore、外部认证插件和 token 同步的现有实现，区分服务端身份与本地凭据。
---

# 1Passport 与外部 SSO 接入边界

[packages/auth](../../packages/auth/src/index.ts)提供本地 token 管理接口；仓库内适配器是 [FeishuAuthAdapter](../../packages/auth/src/adapters/feishu.ts)。ByteDance SSO 的 Device Code、JWT 换取和登录命令由外部插件决定，仓库没有内建该适配器，不能据此文假定某台机器已安装或某项外部服务协议仍可用。

本地工具的 token 与 [Remi 服务端用户/工作区授权](../dev/auth.md)是不同的身份边界。本地 AuthStore 的持久化按 service/type 分组，不等同于服务端按用户和工作区隔离。

## 当前接入点

| 模块 | 实际职责 |
|---|---|
| [AuthStore](../../packages/auth/src/store.ts) | 注册适配器，恢复 token，调用刷新，合并持久化，并在持久化后执行同步规则。调用方需安排 `checkAndRefreshAll`；存在该方法不等于后台任务已自动启动。 |
| [AuthAdapter](../../packages/auth/src/types.ts) | 外部适配器的 token 获取、刷新、状态和持久化回调契约。 |
| [Remi.boot](../../packages/remi/src/core.ts) | 这里有 AuthStore + Feishu adapter + 插件 core hook 的装配；当前 daemon worker 没有调用该工厂，不能将这条装配描述成所有 `remi start` 进程的默认能力。 |
| [PluginRegistry](../../packages/daemon/src/agent-runtime/plugins/registry.ts) | 读取外部插件 `plugin.json` 与入口文件，分别派发 core 和 CLI hook；外部插件需要显式启用。 |
| [CLI Registry](../../apps/remi/cli/index.ts) | 装载已启用插件贡献的命令并注明来源。当前没有内建顶层 `remi auth`；外部插件的登录命令以 `remi --help` 和插件自己的帮助为准。 |

外部插件目录默认为 `~/.remi/plugins`。配置由 [loadConfig](../../packages/shared/src/config.ts)读取环境变量：`REMI_PLUGINS_DIR`、`REMI_PLUGINS_ALLOW_EXTERNAL`、`REMI_PLUGINS_ENABLED_JSON`、`REMI_PLUGIN_CONFIGS_JSON`。插件私有的 client ID、服务地址、scope 和登录流程应由该插件的配置契约说明，本仓库不维护一份推测的副本。

## Token 同步

[TokenSyncEngine](../../packages/auth/src/token-sync.ts)支持 `mirror`、`json_kv`、`bytedcli_token`、`raw`、`env`。规则由 `REMI_TOKEN_SYNC_RULES_JSON` 解析，默认是空数组，不会默认写入外部工具目录。只有宿主把规则传入 AuthStore/TokenSyncEngine 并触发持久化或同步，目标文件才会更新。

下面是规则结构示例，不包含凭据；`source` 必须匹配实际已注册的 service/type，`target` 使用接入者选定的路径：

```json
[
  {
    "name": "tool-access-token",
    "source": "your-sso-service/access",
    "target": "/absolute/path/to/tool-token.json",
    "format": "json_kv",
    "key": "token"
  }
]
```

选择格式会改变导出的凭据范围：`mirror` 导出整个 adapter 的 token 数据，`bytedcli_token` 在数据存在时包含 `refresh_token`。当前同步写入直接调用 `writeFileSync`；[TokenPersistence](../../packages/auth/src/persistence.ts)也直接写 JSON，不能将它们描述成已实现原子替换或跨平台私有权限保证。Windows 访问控制需要按实际文件 ACL 验证。

## 验证入口与缺口

[config.test.ts](../../tests/unit/shared/config.test.ts)覆盖环境变量与规则结构；[cli-plugin-registry.test.ts](../../tests/unit/remi/cli-plugin-registry.test.ts)覆盖插件命令来源、帮助与内建命令冲突：

```bash
bun test tests/unit/shared/config.test.ts tests/unit/remi/cli-plugin-registry.test.ts
```

这些测试不证明外部 SSO 登录、token 刷新和目标工具读入已通过。接入时还需用临时 token 数据与临时目录验证导出范围，再在真实插件环境验证登录/过期刷新/同步；核对宿主确实调用了对应 hook。本文不记录未经执行的外部服务验证结果。
