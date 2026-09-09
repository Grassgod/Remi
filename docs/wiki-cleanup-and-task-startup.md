# Wiki Cleanup and Task Startup

Repository Wiki writes use durable staged content, canonical promotion, and cleanup.
Once promotion is committed, the remaining temporary/obsolete files are garbage,
not a prerequisite for reading the published Wiki.

## Read Path

Repository `list`, `get`, `search`, and task hydration no longer run storage repair
or wait for a storage writer. They read the metadata-referenced, checksum-verified
content. A deferred promotion can still be read from its committed staged URI.
Unavailable content remains explicitly marked unavailable.

Task claim shares a five-second budget across Project and Repository Wiki loading.
In-flight OpenViking requests and retries are cancelled when it expires. A completed
stage is retained; an incomplete stage is omitted with `knowledge_warnings` in the
claim and in both Bootstrap/Delta prompts. Agents use `remi wiki project` and
`remi wiki repository` to retrieve missing context when needed. Repository checkout
scope is resolved independently so a slow Wiki does not strip an automation's repo.
Concurrent claim requests on one runtime share preparation within the API process;
a task cancelled during hydration is not returned for execution.

## Storage Worker

The server-owned worker runs every five seconds and respects
`MULTIREMI_BACKGROUND_JOBS=false` on blue/green candidates. It resumes durable jobs
after restart. A database lease prevents two processes from executing one job.
Each attempt has a 60-second budget, with a renewable 120-second lease. Failures
back off up to five minutes instead of being retried on every read.

Cleanup uses `DELETE ...&wait=false`: the request still deletes the resource, but
does not await OpenViking's semantic refresh. Semantic/index freshness is eventually
consistent and is not claimed to be immediate. Missing files (404) count as cleaned.
Successful paths are checkpointed individually; failures and final snapshot errors
are retried without deleting successful paths again. The job is removed only after
all deletions and the cleanup snapshot succeed.

`MULTIREMI_WIKI_CLEANUP_CONCURRENCY` configures per-job deletion concurrency:
default **8**, valid range **1–32**. The background worker processes one job at a
time. Benchmark 8/16/32 against deletion throughput, errors, retrieval latency and
semantic queue backlog before raising production concurrency.

Every target must be an exact Markdown file within the job's repository or staging
batch, and must not be referenced by current Wiki metadata. No recursive directory
deletion is used. New Wiki writes remain serialized behind prior storage work;
they may finish prior cleanup before starting another batch, because the store
allows only one active storage batch per repository. Ordinary task startup and all
read paths do not wait on that serialization.

Deploy the API for the cleanup/read-path fix; upgrade daemons as well to display
the new knowledge warnings in assembled prompts. This change does not reset tasks,
remove production job records, or change Issue status manually.
