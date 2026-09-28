# MUL-402 conversation log reconciliation

Synthetic fixtures and cold-start qualification on Bun 1.3.14. No production data or credentials. Scale: 15,000 events, 5,106 live comments (6 missing-Issue orphans), 250 tombstones, 4,500 messages in 191 chats; 2 KiB synthetic bodies. Timings include the full Store startup, not fixture generation or reconciliation.

Generated: 2026-09-28T13:26:47.097Z

Authority: MUL-427; cmt_gestk2r6imjh (f)(g), cmt_o1oocq58vsbg (s), Senior cmt_u7m8e7yitmai.

Counts and digests are read from synthetic/local sources. The reconciliation command opens no Store and runs no migrations.
Hash: SHA-256 over canonical tuples of mapped kind, author type/id, raw body, created_at, task_id and parent_id.
Comment task ids come from comments (NULL for tombstones), other Issue rows from events, Chat rows from messages, heads from NULL.
JSON metadata is parsed in Bun, without SQL JSON casts; marker targets and tombstones are checked separately.

This rerun includes B5 `bf9338e4` and ruling (l) `42d83dcd`. Counts and all four
zero-mismatch results are unchanged from the previous run. Previous cold / second
startup: SQLite 697.63 / 30.04 ms, PostgreSQL 6383.09 / 984.32 ms. After the first
B5 merge: SQLite 748.71 / 31.45 ms, PostgreSQL 6566.51 / 1041.98 ms. This run:
SQLite 810.78 / 33.09 ms, PostgreSQL 6936.21 / 1019.48 ms. The timings include
full Store startup and are observations, not a performance threshold.

## sqlite acceptance fixture

Mismatch: **0**

| Counter | Reconciliation | Migration |
| --- | ---: | ---: |
| issueSessions | 1 | 1 |
| chatSessions | 2 | 2 |
| sessionEvents | 17 | 17 |
| mirroredComments | 6 | 6 |
| editedComments | 1 | 1 |
| deletedComments | 1 | 1 |
| orphanCommentsAppended | 1 | 1 |
| orphanCommentsSkipped | 1 | 1 |
| chatMessages | 4 | 4 |
| chatConflictSessions | 0 | 1 |
| chatReorderedMessages | 0 | 2 |
| tasksWithoutAssistant | 2 | 2 |
| insertedRows | 0 | 23 |
| existingRowsSkipped | 0 | 2 |
| commentTaskIdsFilled | 0 | 2 |
| chatOwnedTopicTasks | 1 | 1 |
| chatOwnedTopicIssueLogRows | 0 | 0 |
| chatOwnedTopicChatLogRows | 1 | 1 |
| maxReadResultBytes | 8413 | 5915 |

Sessions: 3; expected rows: 25; actual rows: 25.
Equal session digests: 3/3.

Orphan dispositions and Chat sequence remaps are listed in the JSON report; all per-session source/log digests are included.

## sqlite cold startup

Mismatch: **0**

Cold startup: 810.78 ms; second startup: 33.09 ms.

| Counter | Reconciliation | Migration |
| --- | ---: | ---: |
| issueSessions | 128 | n/a |
| chatSessions | 191 | n/a |
| sessionEvents | 15000 | n/a |
| mirroredComments | 5350 | n/a |
| editedComments | 128 | n/a |
| deletedComments | 250 | n/a |
| orphanCommentsAppended | 0 | n/a |
| orphanCommentsSkipped | 6 | n/a |
| chatMessages | 4500 | n/a |
| chatConflictSessions | 0 | n/a |
| chatReorderedMessages | 0 | n/a |
| tasksWithoutAssistant | 0 | n/a |
| insertedRows | 0 | n/a |
| existingRowsSkipped | 0 | n/a |
| commentTaskIdsFilled | 0 | n/a |
| chatOwnedTopicTasks | 1 | n/a |
| chatOwnedTopicIssueLogRows | 0 | n/a |
| chatOwnedTopicChatLogRows | 1 | n/a |
| maxReadResultBytes | 78621 | n/a |

Sessions: 319; expected rows: 19819; actual rows: 19819.
Equal session digests: 319/319.

Orphan dispositions and Chat sequence remaps are listed in the JSON report; all per-session source/log digests are included.

## pg acceptance fixture

Mismatch: **0**

| Counter | Reconciliation | Migration |
| --- | ---: | ---: |
| issueSessions | 1 | 1 |
| chatSessions | 2 | 2 |
| sessionEvents | 17 | 17 |
| mirroredComments | 6 | 6 |
| editedComments | 1 | 1 |
| deletedComments | 1 | 1 |
| orphanCommentsAppended | 1 | 1 |
| orphanCommentsSkipped | 1 | 1 |
| chatMessages | 4 | 4 |
| chatConflictSessions | 0 | 1 |
| chatReorderedMessages | 0 | 2 |
| tasksWithoutAssistant | 2 | 2 |
| insertedRows | 0 | 23 |
| existingRowsSkipped | 0 | 2 |
| commentTaskIdsFilled | 0 | 2 |
| chatOwnedTopicTasks | 1 | 1 |
| chatOwnedTopicIssueLogRows | 0 | 0 |
| chatOwnedTopicChatLogRows | 1 | 1 |
| maxReadResultBytes | 8413 | 5915 |

Sessions: 3; expected rows: 25; actual rows: 25.
Equal session digests: 3/3.

Orphan dispositions and Chat sequence remaps are listed in the JSON report; all per-session source/log digests are included.

## pg cold startup

Mismatch: **0**

Cold startup: 6936.21 ms; second startup: 1019.48 ms.

| Counter | Reconciliation | Migration |
| --- | ---: | ---: |
| issueSessions | 128 | n/a |
| chatSessions | 191 | n/a |
| sessionEvents | 15000 | n/a |
| mirroredComments | 5350 | n/a |
| editedComments | 128 | n/a |
| deletedComments | 250 | n/a |
| orphanCommentsAppended | 0 | n/a |
| orphanCommentsSkipped | 6 | n/a |
| chatMessages | 4500 | n/a |
| chatConflictSessions | 0 | n/a |
| chatReorderedMessages | 0 | n/a |
| tasksWithoutAssistant | 0 | n/a |
| insertedRows | 0 | n/a |
| existingRowsSkipped | 0 | n/a |
| commentTaskIdsFilled | 0 | n/a |
| chatOwnedTopicTasks | 1 | n/a |
| chatOwnedTopicIssueLogRows | 0 | n/a |
| chatOwnedTopicChatLogRows | 1 | n/a |
| maxReadResultBytes | 78621 | n/a |

Sessions: 319; expected rows: 19819; actual rows: 19819.
Equal session digests: 319/319.

Orphan dispositions and Chat sequence remaps are listed in the JSON report; all per-session source/log digests are included.
