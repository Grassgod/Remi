# Agent、Skill 与 Plugin

## 云友定义

```sh
remi agent list --json
remi agent get <agent-id> --json
remi agent template list --json
remi runtime list --json
remi runtime model list <runtime-id> --json
remi agent create --help
remi agent update --help
```

创建或修改前确认 provider、模型和可执行 Runtime；当前 provider 值为 `claude`、`codex`、`antigravity`，AGY 使用 `antigravity`，不写 `agy`。模型从兼容 Runtime 的目录或用户明确指定的自定义连接取得。不要机械照搬另一个平台的 `--runtime-id`、MCP 或模型参数。

```sh
remi agent create --file <agent.json> --json
remi agent update <agent-id> --file <agent-patch.json> --json
remi agent get <agent-id> --json
```

常见请求字段是 `name`、`description`、`instructions`、`provider`、`model`、`thinking_level`、`visibility`、`max_concurrent_tasks`。更新只发送需要改变的字段，不把 get 响应整个回传。新建时显式写 provider；CLI 缺省为 Claude。

云友指令按六个问题组织：身份、职责边界、禁止事项、专属工具约定、交付物、何时需要补充信息。使用真实 Markdown 换行，通常控制在 100–4000 字符；长操作手册放 Skill。`description` 简述职责，`instructions` 不复制平台注入的整个工作流程。长期云友的头像使用 Remi 附件地址 `/api/attachments/<id>/content`；不提供不可信外链。清空头像使用 `avatar_url: ""`，`null` 不表示清空。

`agent default` 可能创建对象，不是只读的“查看默认云友”。角色和 supervisor 权限也不随普通配置自动提升；确实要求调整时再查看 `remi agent role set --help`。

## 环境变量

```sh
remi agent env get <agent-id> --json
remi agent env update <agent-id> --file <private-env.json> --json
```

此接口供有权限的人类管理，读写响应可能含明文；在受控进程内处理，只报告键名或是否已配置。请求示意为 `{"custom_env":{"LOG_LEVEL":"info"}}`。

**update 替换整个映射。** 先获取现有映射，在内存里合并用户要改的键，再提交完整结果；遗漏的键会被移除。不要用只含一个新 key 的请求无意清空其他凭据。Runtime 自定义模型连接使用 [Runtime 配置](runtimes.md)；其 `env` 模式从 daemon 进程取值，不能靠同名 Agent 环境变量替代。

## Skill 入库与绑定

```sh
remi skill list --json
remi skill get <skill-id> --json
remi skill import --url <supported-skill-url> --json
remi agent skill list <agent-id> --json
remi agent skill add <agent-id> --skill <skill-id> --json
remi agent skill list <agent-id> --json
```

导入成功只创建 Skill 库资源；读取返回的 Skill ID 后再绑定。URL 需指向真正的 Skill 根目录，尤其是包含多个 Skill 的仓库。保留 `references/`、`scripts/` 等配套文件，不仅复制 `SKILL.md`。

本地编写的内容可通过 `remi skill create --file <skill.json> --json` 入库，请求示意：

```json
{
  "name": "example-skill",
  "description": "核对项目检查结果；用户要求汇总检查结论时使用。",
  "content": "# 检查结果\n\n读取 supporting references 后完成用户要求的核对。",
  "files": [{"path": "references/checks.md", "content": "# 检查范围\n\n按项目现有验证入口执行。"}]
}
```

`content` 是主文档，`files` 不再包含 `SKILL.md`。文件路径相对于 Skill，不能是绝对路径或包含 `..`。二进制配套文件使用 `encoding: "base64"` 并要求兼容 daemon。读回 `remi skill file list <skill-id> --json` 检查文件是否齐全。

添加绑定用 `agent skill add`；`agent skill set` **替换全部绑定**，不传 `--skill` 会清空。移除一个绑定时，先列出当前 ID，提交保留的集合。不要因此归档所有 Agent 共用的 Skill 库对象。

位于 Runtime 机器上的 Skill 使用异步扫描导入：

```sh
remi runtime skill scan <runtime-id> --root <remote-skills-directory> --json
remi runtime skill status <runtime-id> <scan-request-id> --json
remi runtime skill import <runtime-id> --scan-request <scan-request-id> --key <returned-skill-key> --json
remi runtime skill import-status <runtime-id> <import-request-id> --json
```

使用扫描返回的 key，等待导入完成后再绑定；本机 Windows 路径不能当作 Mac Runtime 上的路径。

## Provider 原生 Plugin

```sh
remi plugin list --json
remi plugin import --help
remi agent plugin list <agent-id> --json
remi agent plugin bind --help
remi agent plugin update --help
```

Plugin 与 Skill 分别管理，不能互换 ID。原生 Plugin 的 provider 过滤目前是 Claude / Codex；AGY Agent 并不意味着 AGY Plugin 也受支持。导入、激活版本与 Agent 绑定分别核验，不把仅入库称为已生效。MCP 的具体配置依赖提供者和已公开的配置入口；当前没有通用 `remi agent mcp` 命令，不从其他平台手册猜一个写法。
