#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: rehearse-unified-model-copy.sh
  --copy-backup-dir DIR --work-dir NEW_DIR --pg-image IMAGE@sha256:DIGEST --pg-major N
  --candidate-image IMAGE@sha256:DIGEST --candidate-sha FULL_SHA
  --old-image IMAGE@sha256:DIGEST --old-sha FULL_SHA
  [--execute --operator Remi-CC --approval-ref APPROVAL_COMMENT]
Default: print the plan only, with no Docker/database operations.
Execute only after 贺华杰 approval, by Remi-CC. Input is an existing verified
copy backup (platform.pgdump, api-home.tar.gz, SHA256SUMS). No production URLs,
env files, mounts, Compose projects, ports, bots, daemons or traffic are used.
USAGE
}
backup_dir='' work_dir='' pg_image='' pg_major='' candidate_image='' candidate_sha=''
old_image='' old_sha='' operator='' approval_ref='' execute=0
while (($#)); do
  case "$1" in
    --copy-backup-dir) backup_dir="${2:?missing directory}"; shift 2;;
    --work-dir) work_dir="${2:?missing directory}"; shift 2;;
    --pg-image) pg_image="${2:?missing image}"; shift 2;;
    --pg-major) pg_major="${2:?missing major}"; shift 2;;
    --candidate-image) candidate_image="${2:?missing image}"; shift 2;;
    --candidate-sha) candidate_sha="${2:?missing SHA}"; shift 2;;
    --old-image) old_image="${2:?missing image}"; shift 2;;
    --old-sha) old_sha="${2:?missing SHA}"; shift 2;;
    --operator) operator="${2:?missing operator}"; shift 2;;
    --approval-ref) approval_ref="${2:?missing approval reference}"; shift 2;;
    --execute) execute=1; shift;;
    --help|-h) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done
[[ "$backup_dir" == /* && "$work_dir" == /* && "$pg_major" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
for image in "$pg_image" "$candidate_image" "$old_image"; do
  [[ "$image" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || { echo 'All three images must be pinned by digest' >&2; exit 2; }
done
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ && "$old_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Full source SHAs are required' >&2; exit 2; }
if (( ! execute )); then
  echo 'PLAN ONLY: verify copy backup; create new internal network + empty PG; restore copy; old-code startup; copy backup; candidate migration + restart + reconciliation; restore copy backup; old-code restart + rollback comparison; remove only newly created Docker resources.'
  echo "Candidate: $candidate_sha; old: $old_sha; PostgreSQL major: $pg_major"
  echo 'Pending: 贺华杰 approval, Remi-CC execution, Issue derivation sample review and measured timings.'
  exit 0
fi
[[ "$operator" == 'Remi-CC' && -n "$approval_ref" ]] || { echo 'Execution requires Remi-CC and the recorded 贺华杰 approval reference' >&2; exit 2; }
[[ -d "$backup_dir" && ! -e "$work_dir" && ! -L "$work_dir" ]] || { echo 'Copy backup must exist; work directory must be new' >&2; exit 2; }
for file in platform.pgdump api-home.tar.gz SHA256SUMS; do
  [[ -s "$backup_dir/$file" && ! -L "$backup_dir/$file" ]] || { echo 'Missing or symlinked copy backup file' >&2; exit 2; }
done
# Explicit local Unix socket: never inherit a remote Docker context or SSH host.
docker_local() { docker --host unix:///var/run/docker.sock "$@"; }
for tool in docker tar sha256sum python3 sed cmp; do command -v "$tool" >/dev/null; done
for image in "$candidate_image" "$old_image" "$pg_image"; do docker_local image inspect "$image" >/dev/null; done
for pair in candidate old; do
  if [[ "$pair" == candidate ]]; then image="$candidate_image"; expected="$candidate_sha";
  else image="$old_image"; expected="$old_sha"; fi
  actual=$(docker_local image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  [[ "$actual" == "$expected" ]] || { echo 'Image revision does not match approved source SHA' >&2; exit 2; }
done
(cd "$backup_dir" && sha256sum --check --status SHA256SUMS)
archive_listing=$(tar -tzf "$backup_dir/api-home.tar.gz")
if python3 -c 'import sys; names=sys.stdin.read().splitlines(); sys.exit(0 if any(n.startswith("/") or ".." in n.split("/") for n in names) else 1)' <<< "$archive_listing"; then
  echo 'Unsafe api-home archive path' >&2; exit 2
fi
# No existing directory or Docker resource can be adopted by this run.
mkdir "$work_dir"
work_dir=$(cd "$work_dir" && pwd -P)
mkdir "$work_dir/api-home" "$work_dir/evidence" "$work_dir/scratch"
printf '%s\n' "operator=$operator" "approval_ref=$approval_ref" "candidate_sha=$candidate_sha" "old_sha=$old_sha" "pg_major=$pg_major" > "$work_dir/evidence/authorization.txt"
tar --no-same-owner --no-same-permissions -xzf "$backup_dir/api-home.tar.gz" -C "$work_dir/api-home"
run_id="mul493-copy-$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
network='' volume='' pg_container=''
cleanup() {
  local status=$?
  # IDs are populated only after this invocation successfully created them.
  if [[ -n "$pg_container" ]] && ! docker_local rm -f "$pg_container" >/dev/null; then echo 'Copy container cleanup failed' >&2; status=1; fi
  if [[ -n "$volume" ]] && ! docker_local volume rm "$volume" >/dev/null; then echo 'Copy volume cleanup failed' >&2; status=1; fi
  if [[ -n "$network" ]] && ! docker_local network rm "$network" >/dev/null; then echo 'Copy network cleanup failed' >&2; status=1; fi
  return "$status"
}
trap cleanup EXIT
network=$(docker_local network create --internal --label remi.rehearsal=MUL-493 "$run_id")
printf 'network=%s\n' "$network" > "$work_dir/evidence/docker-resources.txt"
volume=$(docker_local volume create --label remi.rehearsal=MUL-493 "$run_id")
printf 'volume=%s\n' "$volume" >> "$work_dir/evidence/docker-resources.txt"
pg_container=$(docker_local run -d --name "$run_id" --network "$network" --network-alias mul493-copy-postgres \
  --mount "type=volume,source=$volume,target=/var/lib/postgresql/data" \
  --env POSTGRES_USER=mul493_rehearsal --env POSTGRES_DB=mul493_rehearsal \
  --env POSTGRES_HOST_AUTH_METHOD=trust "$pg_image")
printf 'container=%s\nname=%s\n' "$pg_container" "$run_id" >> "$work_dir/evidence/docker-resources.txt"
ready=0
for ((i=0; i<60; i++)); do
  if docker_local exec "$pg_container" pg_isready -U mul493_rehearsal -d mul493_rehearsal >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
((ready)) || { echo 'Isolated PG did not become ready' >&2; exit 1; }
pg() { docker_local exec "$pg_container" "$@"; }
actual_major=$(pg psql -X -U mul493_rehearsal -d mul493_rehearsal -Atc 'SHOW server_version_num')
[[ "$((actual_major/10000))" == "$pg_major" ]] || { echo 'PostgreSQL major mismatch' >&2; exit 2; }
started_ms() { python3 -c 'import time; print(time.monotonic_ns()//1000000)'; }
measure() {
  local label="$1" start end; shift
  start=$(started_ms)
  if ! "$@" >"$work_dir/evidence/$label.private.log" 2>&1; then
    echo "$label failed; private diagnostics retained, no production action taken" >&2; return 1
  fi
  end=$(started_ms)
  printf '%s\t%s\n' "$label" "$((end-start))" >> "$work_dir/evidence/durations-ms.tsv"
}
restore_copy() {
  docker_local exec -i "$pg_container" pg_restore --exit-on-error --no-owner --no-privileges \
    -U mul493_rehearsal -d mul493_rehearsal < "$1"
}
copy_url='postgresql://mul493_rehearsal@mul493-copy-postgres:5432/mul493_rehearsal'
job() {
  local image="$1"; shift
  docker_local run --rm --network "$network" --user "$(id -u):$(id -g)" \
    --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
    --mount "type=bind,source=$work_dir/api-home,target=/srv/multiremi" \
    --mount "type=bind,source=$work_dir/evidence,target=/evidence" \
    --mount "type=bind,source=$work_dir/scratch,target=/scratch" \
    --env HOME=/srv/multiremi --env MULTIREMI_STATE_DIR=/scratch/state \
    --env MUL493_COPY_DATABASE_URL="$copy_url" \
    --workdir /app --entrypoint bun "$image" "$@"
}
old_startup() {
  job "$old_image" -e 'import {PostgresSyncDatabase} from "./packages/server/src/store/db/postgres.ts"; import {runMigrations} from "./packages/server/src/store/migrations.ts"; const db=new PostgresSyncDatabase(process.env.MUL493_COPY_DATABASE_URL); try {runMigrations(db)} finally {db.close()}'
}
snapshot() {
  # A full plain dump verifies schema, constraints and data, not just counts.
  # Strip dump's randomized \restrict token before hashing the deterministic SQL.
  pg pg_dump -U mul493_rehearsal -d mul493_rehearsal --no-owner --no-privileges | \
    sed '/^\\restrict /d; /^\\unrestrict /d' | sha256sum
}
measure restore-source-copy restore_copy "$backup_dir/platform.pgdump"
snapshot > "$work_dir/evidence/source-copy-data.sha256"
measure old-copy-startup old_startup
snapshot > "$work_dir/evidence/pre-cutover-data.sha256"
cmp "$work_dir/evidence/source-copy-data.sha256" "$work_dir/evidence/pre-cutover-data.sha256"
measure backup-copy-db bash -c '"$@" > "$0"' "$work_dir/evidence/rollback.pgdump" \
  docker --host unix:///var/run/docker.sock exec "$pg_container" pg_dump -U mul493_rehearsal -d mul493_rehearsal --format=custom
measure backup-copy-home tar -C "$work_dir/api-home" -czf "$work_dir/evidence/rollback-api-home.tar.gz" .
docker_local exec -i "$pg_container" pg_restore --list /dev/stdin < "$work_dir/evidence/rollback.pgdump" > "$work_dir/evidence/rollback-restore-list.txt"
(cd "$work_dir/evidence" && sha256sum rollback.pgdump rollback-api-home.tar.gz > ROLLBACK-SHA256SUMS)
candidate_failed=0
if ! measure candidate-migration job "$candidate_image" run scripts/rehearse-unified-model-copy.ts --report-dir /evidence/migrations; then candidate_failed=1; fi
# Always rehearse restoration before asking for any production cutover approval.
measure rollback-empty-db pg psql -X -v ON_ERROR_STOP=1 -U mul493_rehearsal -d postgres \
  -c 'DROP DATABASE mul493_rehearsal WITH (FORCE)' -c 'CREATE DATABASE mul493_rehearsal OWNER mul493_rehearsal'
(cd "$work_dir/evidence" && sha256sum --check --status ROLLBACK-SHA256SUMS)
measure rollback-restore-db restore_copy "$work_dir/evidence/rollback.pgdump"
mv "$work_dir/api-home" "$work_dir/migrated-api-home"
mkdir "$work_dir/api-home"
measure rollback-restore-home tar --no-same-owner --no-same-permissions -xzf "$work_dir/evidence/rollback-api-home.tar.gz" -C "$work_dir/api-home"
snapshot > "$work_dir/evidence/restored-data.sha256"
cmp "$work_dir/evidence/pre-cutover-data.sha256" "$work_dir/evidence/restored-data.sha256"
measure rollback-old-startup old_startup
snapshot > "$work_dir/evidence/old-restart-data.sha256"
cmp "$work_dir/evidence/pre-cutover-data.sha256" "$work_dir/evidence/old-restart-data.sha256"
(( ! candidate_failed )) || { echo 'Candidate failed; copy rollback was verified. Rehearsal is NOT successful.' >&2; exit 1; }
echo 'COPY REHEARSAL checks completed; Issue status samples still require manual review. Evidence remains private in the new work directory. No production services were started or changed.'
