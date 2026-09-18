---
title: 迁移本地 Feishu bot menu
status: active
summary: 仅从仍含 remi_config 的本地数据库或启动备份迁移菜单到工作区设置，默认只读预览。
---

# 迁移本地 Feishu bot menu

仅当已有安装在本地 SQLite 的 `remi_config` 保存了 botMenu，而目标工作区尚未迁入该配置时使用本页。当前配置位于工作区 `settings.botMenu`；迁移脚本及具体转换规则见[migrate-remi-bot-menu.ts](../../scripts/migrations/migrate-remi-bot-menu.ts)。当前启动过程不读取旧菜单值，新安装无需执行此步骤。

脚本以只读方式打开源库，默认只打印菜单数量：

```bash
bun run scripts/migrations/migrate-remi-bot-menu.ts
```

默认源库为 `~/.remi/remi.db`；非默认位置使用 `REMI_DB_PATH`。若源库已没有 `remi_config`，应指定仍保留该表的一致性备份。`--backup` 不带路径时选择源库旁的 `.pre-remi-config-purge-v2.bak` 文件，带路径时读取指定文件：

```bash
bun run scripts/migrations/migrate-remi-bot-menu.ts --backup
bun run scripts/migrations/migrate-remi-bot-menu.ts --backup <backup-path>
```

核对数量并备份源库和目标菜单设置后，在当前 shell 配置 `MULTIREMI_SERVER_URL`、`MULTIREMI_WORKSPACE_ID`、`MULTIREMI_TOKEN`。使用具备目标工作区权限的身份执行：

```bash
bun run scripts/migrations/migrate-remi-bot-menu.ts --apply
```

如果预览使用了 `--backup`，apply 时必须传同一 backup 参数。`--apply` 通过工作区 bot-menu API 写入转换结果；它不是只读操作，可能替换目标已有菜单。脚本不删除源行，也不向飞书发布菜单。

转换保留个性化菜单的显式 external target（open_id/union_id/user_id）。之后在工作区设置中检查并按需改为成员或角色目标，运行菜单 dry-run，确认结果后再通过正常发布入口发布。当前 API 与发布流程见[工作区路由](../../packages/server/src/api/routers/workspaces.ts)、[CLI 工作区命令](../../apps/remi/cli/commands/workspace.ts)。本页未声明对任何安装执行过迁移。
