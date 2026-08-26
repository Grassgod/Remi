# Session Archive Retry Budget

Session Archive uploads use a server-enforced retry budget. The daemon checks the
current archive before packing session files, while the server remains the
authoritative gate for every upload claim.

## Configuration

| Environment variable | Default | Valid range | Meaning |
| --- | ---: | ---: | --- |
| `MULTIREMI_SESSION_ARCHIVE_RETRY_BASE_MS` | `60000` | 1 second to 1 hour | Initial automatic retry delay |
| `MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_MS` | `3600000` | Base delay to 24 hours | Hard cap for automatic retry delay |
| `MULTIREMI_SESSION_ARCHIVE_RETRY_MAX_ATTEMPTS` | `6` | 1 to 100 | Maximum automatic upload attempts |
| `MULTIREMI_SESSION_ARCHIVE_UPLOAD_STALL_MS` | `900000` | 1 minute to 24 hours | Age after which an `uploading` attempt is stalled |

Invalid values fall back to their defaults. Restart the API service after
changing these process environment variables.

The upload stall threshold measures time since the last persisted upload
progress. If `MULTIREMI_SESSION_ARCHIVE_MAX_BYTES` is increased, reassess
`MULTIREMI_SESSION_ARCHIVE_UPLOAD_STALL_MS` against the maximum expected upload
duration and slowest supported connection.

## Backoff

The delay before another claim is `min(base * 2^(attempt - 1), max)`. A stable
jitter derived from the archive ID shifts each delay by up to 10 percent, while
the configured maximum remains a hard cap. With defaults, the nominal sequence
is 1, 2, 4, 8, 16, and 32 minutes.

The next retry timestamp is written when an attempt is claimed. This protects
against failed uploads, stalled uploads, daemon crashes, and lost completion
requests. A stalled upload is recorded as failed before another claim is
considered.

## Exhaustion And Recovery

When the sixth automatic attempt fails or stalls, the archive remains visible as
failed with an exhausted retry state. Automatic claims stop until an administrator
uses the Retry action in the Issue's Session Archives section or calls:

```text
POST /api/issues/:issueId/session-archives/:archiveId/retry
```

Manual retry resets the attempt count, error, next retry timestamp, and exhaustion
timestamp. It does not bypass the normal upload integrity checks.
