# Remi bot menu migration

MUL-69 moves the Feishu bot menu from the local `remi_config` database into
`multiremi_workspaces.settings.botMenu`. Runtime startup does not migrate or
read the old value.

The migration script opens the legacy SQLite database read-only. Its default
mode prints only menu counts and never prints user identifiers or credentials:

```bash
bun run scripts/migrations/migrate-remi-bot-menu.ts
```

Review the counts, back up `~/.remi/remi.db`, and set the normal Multiremi API
connection variables in the current shell. Then apply the conversion once:

```bash
bun run scripts/migrations/migrate-remi-bot-menu.ts --apply
```

Use `REMI_DB_PATH` only when the legacy database is not at
`~/.remi/remi.db`. The converter preserves legacy personalized entries as
explicit external targets (`open_id`, `union_id`, or `user_id`). After the
migration, prefer replacing those entries in Settings with workspace member or
role targets; those resolve to Feishu identities only at publish time.

If the W4 binary already removed `remi_config`, read the consistent startup
backup instead. With the default database path, `--backup` selects
`~/.remi/remi.db.pre-remi-config-purge-v2.bak`; pass an explicit path when the
backup lives elsewhere:

```bash
bun run scripts/migrations/migrate-remi-bot-menu.ts --backup
bun run scripts/migrations/migrate-remi-bot-menu.ts --backup /path/to/remi.db.pre-remi-config-purge-v2.bak --apply
```

Finally, open **Workspace Settings → Integrations → Feishu bot menu**, run a
dry-run, inspect the result, and publish only after operator approval. The
script does not publish anything to Feishu and does not delete the legacy row.
