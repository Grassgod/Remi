# Migrate Legacy Remi Memory

MUL-69 W2 removed the local `packages/memory` runtime. Existing Markdown under
`~/.remi/memory/` is preserved but is no longer read automatically. Multiremi project memory is
the authoritative replacement.

This is a manual, one-time migration. Review every document before uploading it, choose the
correct Multiremi project, and do not remove the source files until the imported content has been
verified.

## Mapping

| Legacy content | Destination |
|---|---|
| Persona, durable operating rules, tool conventions | The bot agent's `instructions` in the Multiremi agent editor |
| Project facts, decisions, runbooks, and ownership notes | Multiremi project memory via `remi memory create` |
| Daily logs and obsolete observations | Review and distill first; do not bulk-import raw logs |

## Procedure

1. Inventory the source files without changing them:

   ```bash
   find ~/.remi/memory -type f -name '*.md' -print
   ```

2. Move persona and operating rules into the selected bot agent's `instructions`. Keep reusable
   project knowledge out of the persona.

3. Import each reviewed project document. Use a stable slug and the project that owns the facts:

   ```bash
   remi memory create --project <project-id> --title "<title>" --slug <slug> --content-file <path>
   ```

4. Verify the imported document and search behavior:

   ```bash
   remi memory get <slug> --project <project-id>
   remi memory recall "<distinct phrase>" --project <project-id>
   ```

5. Keep `~/.remi/memory/` as a backup until the migration has been reviewed. W2 does not delete
   it. Old `vec_items` metadata, when present, may require a maintenance binary with sqlite-vec
   loaded before SQLite can drop the virtual table; it contains a derived index, not source
   Markdown.
