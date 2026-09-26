# MUL-386 knowledge `db_bytes` before/after

| | |
| --- | --- |
| baseline commit | `a1e6162312b34d272e22b633d185f014f535f23e` |
| after commit | `92f99d452f3bfdb75d1c327dba8fb8f3a0128c65` |
| accounting | `db_bytes = JSON.stringify({ rows, count })` per statement, byte-for-byte what `pg-worker.ts` writes into the shared buffer |
| database | PostgreSQL (see JSON `reports[].database`) |

Acceptance is `db_bytes`, not the HTTP response size: a 12 MB reply still costs the
main thread a `JSON.stringify` into the shared buffer plus a `TextDecoder` +
`JSON.parse`, so removing fields from the response JSON without changing the list SQL
would leave this number untouched.

## Per route

| route | db_bytes before | db_bytes after | before (MiB) | after (MiB) | reduction | statements |
| --- | --- | --- | --- | --- | --- | --- |
| submissions list | 12085257 | 396399 | 11.53 | 0.38 | 30.5x | 694 -> 694 |
| runs list | 15082499 | 213027 | 14.38 | 0.20 | 70.8x | 503 -> 404 |
| recall | 16286206 | 28941 | 15.53 | 0.03 | 562.7x | 42 -> 42 |

## Largest contributing statements

Rows are joined on the normalized statement label. A `0` on the after side means that
statement is no longer issued at all (the big `SELECT *` was replaced by a projection);
a new statement therefore shows `0` on the before side.

### submissions list

| statement | before bytes | after bytes | before calls | after calls |
| --- | --- | --- | --- | --- |
| `SELECT * FROM multiremi_knowledge_submissions` | 11772417 | 0 | 1 | 0 |
| `SELECT * FROM multiremi_tasks` | 182457 | 182457 | 99 | 99 |
| `SELECT * FROM multiremi_agents` | 63162 | 63162 | 99 | 99 |
| `SELECT * FROM multiremi_issues` | 62667 | 62667 | 99 | 99 |
| `SELECT id FROM multiremi_issues` | 4554 | 4554 | 99 | 99 |
| `SELECT l.* FROM multiremi_issue_labels` | 0 | 0 | 99 | 99 |

### runs list

| statement | before bytes | after bytes | before calls | after calls |
| --- | --- | --- | --- | --- |
| `SELECT * FROM multiremi_knowledge_compilation_run_sources` | 6965638 | 0 | 100 | 0 |
| `SELECT * FROM multiremi_repository_wiki_docs` | 5937782 | 0 | 1 | 0 |
| `SELECT * FROM multiremi_project_docs` | 2032435 | 0 | 100 | 0 |
| `SELECT * FROM multiremi_agents` | 63800 | 63800 | 100 | 100 |
| `SELECT * FROM multiremi_knowledge_compilation_outputs` | 48000 | 48000 | 100 | 100 |
| `SELECT * FROM multiremi_knowledge_compilation_runs` | 34422 | 34422 | 1 | 1 |

### recall

| statement | before bytes | after bytes | before calls | after calls |
| --- | --- | --- | --- | --- |
| `SELECT * FROM multiremi_project_docs` | 16274260 | 0 | 20 | 0 |
| `SELECT p.*, COUNT(i.id) AS issue_count, COALESC FROM multiremi_project_resources` | 11946 | 11946 | 22 | 22 |
| `SELECT id, project_id, workspace_id, kind, slug FROM multiremi_project_docs` | 0 | 16995 | 0 | 20 |

