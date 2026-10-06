---
title: 公开参考价格导入操作
status: active
summary: 固定 gateway catalog 的来源、逐分量排除和只读计划／受控数据库导入。
---

# 公开参考价格导入

[参考目录](../packages/server/src/store/data/usage-reference-prices.json)固定 Wei-Shaw/model-price-repo 的 commit `f723eee74abf53adfb6d1a5ca7633f3823964315`，保存两个来源文件的 SHA-256、获取时间、原始 SKU、相关价格和条件字段、custom/alias 定义、USD/token 单位与逐分量决定。这是 Sub2API/CRS 的公共 gateway catalog 参考，包含同步和自定义定义；目录所链接的厂商页面不是本次重新核实的厂商发票。自定义汇率换算保留原始定义，不重新换汇。

[维护脚本](../scripts/import-usage-reference-prices.ts)只生成现有 `published` 价格版本，金额计算继续使用 [统一用量报表](usage-accounting.md)。参考金额不提高 `priced_tokens` 或确认费用覆盖率。脚本没有网络下载、模型 provider 调用、schema 初始化或启动挂钩，目录不可用不会阻挡服务启动。

目录逐个分量排除不受支持的 service tier、batch、长上下文、cache TTL、地域/fast 倍率、off-peak 和其他计价变体。部分价格允许导入：例如 `deepseek-flash` 只保留明确为零且未受 off-peak 影响的 cache write，其余受时段影响的分量为 null。null 是未知，不是免费。`gpt-6.1-sol` 的层级和上下文条件不能由现有 flat rate 表达，所有相关分量排除。source-defined alias 仅作审计，不按 alias 查找另一个 SKU；请求模型也不能匹配此目录。

价格最早从获取时间 `2026-10-06T07:46:51.000Z` 生效；获取时间、来源 commit 时间和模型发布时间均不证明历史有效性。操作者仍需提供连接适用于该目录的证据及当前有效期间。执行 `provider` 是协议/引擎，不是模型厂商；未知连接、当前模型配置和倍率 1 均不能证明历史路由或实际扣费。历史用量保持原样，计划明确标记 `historical_applicability=not_established`。

## 生成和审核计划

只在明确的备份/隔离数据库演练。脚本要求 `MULTIREMI_DATABASE_URL`、显式不含凭据的 `--target` 和 `--workspace` 三者同时提供，固定使用该数据库的 `public` schema。默认事务为 `REPEATABLE READ READ ONLY`，仅聚合规范化 usage 的 model/provider/connection/time 元数据并读取价格，绝不读任务正文、provider 凭据或连接秘密。每个工作区最多 5000 观测分组、5000 价格和 5000 路由；输入计划文件最多 16 MiB，超限失败。

`routes.json` 是审核者提供的数组，例如（以下连接和证据均为占位示例）：

```json
[
  {
    "provider": "claude",
    "connection_id": "reviewed-gateway-connection",
    "evidence": "Owner-reviewed connection-to-gateway catalog evidence; no credentials",
    "catalog_commit": "f723eee74abf53adfb6d1a5ca7633f3823964315",
    "effective_from": "2026-10-06T07:46:51.000Z",
    "effective_to": null
  }
]
```

没有证据时省略 `--routes`，所有未明确映射的连接得到排除原因。计划为每个观测分组返回拟插入版本或 `unknown_actual_model`、`unknown_route`、`route_not_evidenced_for_catalog`、`source_absent_or_sku_not_reviewed`、`source_alias_not_actual_sku`、`no_unambiguous_components`、`occupied_interval` 或 `already_present`。历史未知路由不会因本次导入得到补全。未进入本次审阅子集的 SKU 与来源不存在的 SKU 都明确排除，不能自动扩展价格。

```bash
# 环境显式设置数据库 URL；不要把凭据写进计划或提交到 Git。
bun run scripts/import-usage-reference-prices.ts --workspace=<id> --target=postgres://<host>:<port>/<database> --routes=<routes.json> --out=<review-plan.json>
# 审核计划的 workspace、target、catalog hash、连接证据、有效期、分量与排除原因。
bun run scripts/import-usage-reference-prices.ts --workspace=<same-id> --target=postgres://<same-host>:<same-port>/<same-database> --apply-plan=<review-plan.json> --execute
```

输出计划使用独占创建和 0600 权限，不覆盖旧计划。计划包含工作区/连接元数据，应保存在维护目录，不能提交到 Git。操作者确认身份与环境后执行；此脚本不会代替平台 API 的管理员鉴权。

## 应用与并发

应用重新从固定目录构建计划并核对全部内容，不能编辑拟导入费率、alias 或时间绕过校验。数据库内在同一事务取得现有 `setPrice`/`closePrice` 使用的工作区生命周期锁，再检查全部价格前提。既有版本变化或新增 configured 价格导致整批拒绝，需重新生成审核计划。

遇到任何占用区间（包括 configured、published 和 requested alias）跳过，不关闭、不覆盖既有版本；已结束且与拟导入期间不相交的版本保持不变。允许先前应用此计划生成的完全相同 published 行作为幂等结果。重复应用不插入价格、不增加 pricing revision。观测快照是审核时的覆盖清单，不因新到达用量自动扩大导入范围；新的 SKU 需要另一个只读审核计划。

验证入口为 [导入测试](../tests/unit/scripts/usage-reference-prices.test.ts)：普通测试使用内存 SQLite，PostgreSQL 并发测试只接受指定隔离测试数据库并使用独立临时 schema；CLI 流程测试在同一隔离测试服务器新建专属临时数据库，结束后删除，不使用已有克隆。

```bash
bun run test tests/unit/scripts/usage-reference-prices.test.ts
MULTIREMI_TEST_REFERENCE_DATABASE_URL=postgres://usage_test:usage_test@127.0.0.1:55486/postgres bun run test tests/unit/scripts/usage-reference-prices.test.ts
```
