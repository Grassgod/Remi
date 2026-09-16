#!/usr/bin/env bash

set -euo pipefail

: "${PPE_ACTION:?PPE_ACTION is required}"
: "${PPE_KUBECTL_VERSION:?PPE_KUBECTL_VERSION is required}"
: "${PPE_KUBECTL_SHA256:?PPE_KUBECTL_SHA256 is required}"
: "${PPE_ACCESS_HOST:?PPE_ACCESS_HOST is required}"
: "${PPE_MAX_ENVIRONMENTS:?PPE_MAX_ENVIRONMENTS is required}"
: "${PPE_TTL_HOURS:?PPE_TTL_HOURS is required}"
: "${PPE_ALLOCATION_LOCK_TTL_MINUTES:?PPE_ALLOCATION_LOCK_TTL_MINUTES is required}"
: "${PPE_WORKFLOW_LOCK_TTL_MINUTES:?PPE_WORKFLOW_LOCK_TTL_MINUTES is required}"
: "${PPE_GC_LOCK_TTL_MINUTES:?PPE_GC_LOCK_TTL_MINUTES is required}"

PPE_SLOT="${PPE_SLOT:-auto}"
case "${PPE_SLOT}" in
  auto|1|2|3|4|5|6) ;;
  *) printf 'invalid PPE_SLOT: %s\n' "${PPE_SLOT}" >&2; exit 64 ;;
esac
case "${PPE_ACTION}" in
  deploy|extend|release|status) ;;
  *) printf 'invalid PPE_ACTION: %s\n' "${PPE_ACTION}" >&2; exit 64 ;;
esac
[[ "${PPE_MAX_ENVIRONMENTS}" == "6" ]] || { printf 'PPE_MAX_ENVIRONMENTS must be 6\n' >&2; exit 64; }
[[ "${PPE_TTL_HOURS}" == "24" ]] || { printf 'PPE_TTL_HOURS must be 24\n' >&2; exit 64; }
[[ "${PPE_ALLOCATION_LOCK_TTL_MINUTES}" =~ ^[0-9]+$ ]] || { printf 'invalid allocation lock TTL\n' >&2; exit 64; }
[[ "${PPE_WORKFLOW_LOCK_TTL_MINUTES}" =~ ^[0-9]+$ ]] || { printf 'invalid workflow lock TTL\n' >&2; exit 64; }
[[ "${PPE_GC_LOCK_TTL_MINUTES}" =~ ^[0-9]+$ ]] || { printf 'invalid GC lock TTL\n' >&2; exit 64; }

PPE_WORKFLOW_LOCK_HEARTBEAT_SECONDS="${PPE_WORKFLOW_LOCK_HEARTBEAT_SECONDS:-30}"
PPE_BUILD_TIMEOUT_SECONDS="${PPE_BUILD_TIMEOUT_SECONDS:-1500}"
PPE_BUILD_PROGRESS_SECONDS="${PPE_BUILD_PROGRESS_SECONDS:-20}"
# The API image builds comfortably inside 6Gi. The Web image runs a Next
# production build, whose worker pool and prerender phase need substantially
# more headroom; NEXT_BUILD_CPUS below keeps that pool from scaling with the
# builder's 64 visible cores. Both fit the namespace ResourceQuota. See MUL-303.
PPE_API_BUILD_MEMORY="${PPE_API_BUILD_MEMORY:-6Gi}"
PPE_WEB_BUILD_MEMORY="${PPE_WEB_BUILD_MEMORY:-12Gi}"
PPE_WEB_BUILD_CPUS="${PPE_WEB_BUILD_CPUS:-4}"

managed_label="multiremi.io/managed=true"
lease_name="ppe-lease"
workflow_lock_name="ppe-workflow-lock"
gc_lock_name="ppe-gc-lock"
allocation_lock_name="ppe-allocation-lock"
allocation_lock_namespace="multiremi-ppe-1"
allocation_lock_owner="${TASK_ID:-unknown}-$(openssl rand -hex 8)"
namespace=""
node_port=""
lease_id=""
expires_at=""
lease_created=0
workflow_lock_acquired=0
allocation_lock_acquired=0
heartbeat_pid=""
deploy_succeeded=0
kubectl_bin="${PWD}/.ppe-bin/kubectl"
mkdir -p "${PWD}/.ppe-bin"

curl -fsSL "https://dl.k8s.io/release/${PPE_KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o "${kubectl_bin}"
printf '%s  %s\n' "${PPE_KUBECTL_SHA256}" "${kubectl_bin}" | sha256sum -c -
chmod 0755 "${kubectl_bin}"

stop_lock_heartbeat() {
  if [[ -n "${heartbeat_pid}" ]]; then
    kill "${heartbeat_pid}" >/dev/null 2>&1 || true
    wait "${heartbeat_pid}" 2>/dev/null || true
    heartbeat_pid=""
  fi
}

# Refresh the lock's started_at so staleness measures "the workflow stopped
# reporting", not "the workflow started long ago". A cancelled or crashed task
# stops the heartbeat, and the lock becomes reclaimable within the TTL instead
# of pinning the slot for the full TTL of a healthy run. See MUL-303.
start_lock_heartbeat() {
  [[ "${workflow_lock_acquired}" == "1" && -n "${namespace}" ]] || return 0
  (
    trap - EXIT INT TERM
    while sleep "${PPE_WORKFLOW_LOCK_HEARTBEAT_SECONDS}"; do
      "${kubectl_bin}" -n "${namespace}" patch configmap "${workflow_lock_name}" --type merge \
        -p "{\"data\":{\"started_at\":\"$(date -u +%FT%TZ)\"}}" >/dev/null 2>&1 || exit 0
    done
  ) &
  heartbeat_pid=$!
}

cleanup_lock() {
  stop_lock_heartbeat
  if [[ "${workflow_lock_acquired}" == "1" && -n "${namespace}" ]]; then
    "${kubectl_bin}" -n "${namespace}" delete configmap "${workflow_lock_name}" --ignore-not-found >/dev/null 2>&1 || true
  fi
}

# A deploy stamps state=provisioning and expires_at=+24h before it builds
# anything. Without this, a failed or cancelled deploy holds a slot that has no
# usable environment in it until that 24h elapses. Expire the lease instead so
# the 5-minute collector reclaims the slot. See MUL-303.
abandon_failed_deploy() {
  [[ "${PPE_ACTION}" == "deploy" && "${deploy_succeeded}" == "0" && -n "${namespace}" ]] || return 0
  [[ -n "${lease_id}" && "$(lease_field "${PPE_SLOT}" lease_id)" == "${lease_id}" ]] || return 0
  "${kubectl_bin}" -n "${namespace}" delete job -l "multiremi.io/component=build" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "${kubectl_bin}" -n "${namespace}" patch configmap "${lease_name}" --type merge \
    -p "{\"data\":{\"state\":\"failed\",\"expires_at\":\"$(date -u +%FT%TZ)\"}}" >/dev/null 2>&1 || true
  printf 'Deploy did not complete; PPE slot %s is marked failed and left to the TTL collector\n' "${PPE_SLOT}" >&2
}

cleanup_allocation_lock() {
  local current_owner
  if [[ "${allocation_lock_acquired}" == "1" ]]; then
    current_owner="$("${kubectl_bin}" -n "${allocation_lock_namespace}" get configmap "${allocation_lock_name}" \
      -o jsonpath='{.data.owner}' 2>/dev/null || true)"
    if [[ "${current_owner}" == "${allocation_lock_owner}" ]]; then
      "${kubectl_bin}" -n "${allocation_lock_namespace}" delete configmap "${allocation_lock_name}" \
        --ignore-not-found >/dev/null 2>&1 || true
    fi
    allocation_lock_acquired=0
  fi
}

cleanup() {
  abandon_failed_deploy
  cleanup_lock
  cleanup_allocation_lock
}
# Zadig cancels a task by tearing the executor pod down. Handle the signals it
# can deliver so the lock is released promptly; the heartbeat above is what
# covers the case where the process is killed outright.
trap cleanup EXIT
trap 'exit 143' INT TERM

slot_namespace() { printf 'multiremi-ppe-%s' "$1"; }
slot_url() { printf 'http://%s:%s' "${PPE_ACCESS_HOST}" "$((32100 + $1))"; }
lease_field() {
  local slot="$1" field="$2"
  "${kubectl_bin}" -n "$(slot_namespace "${slot}")" get configmap "${lease_name}" \
    -o "jsonpath={.data.${field}}" 2>/dev/null || true
}

find_issue_slot() {
  local slot
  for slot in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
    if [[ "$(lease_field "${slot}" issue_key)" == "${ISSUE_KEY}" ]]; then
      printf '%s' "${slot}"
      return
    fi
  done
}

managed_resources_exist() {
  local slot="$1" resources
  resources="$("${kubectl_bin}" -n "$(slot_namespace "${slot}")" get \
    deployment,statefulset,service,job,configmap,secret,persistentvolumeclaim \
    -l "${managed_label}" -o name 2>/dev/null || true)"
  [[ -n "${resources}" ]]
}

workflow_lock_is_stale() {
  local slot="$1" started_at started_epoch now_epoch
  started_at="$("${kubectl_bin}" -n "$(slot_namespace "${slot}")" get configmap "${workflow_lock_name}" \
    -o jsonpath='{.data.started_at}' 2>/dev/null || true)"
  started_epoch="$(date -u -d "${started_at}" +%s 2>/dev/null || true)"
  now_epoch="$(date -u +%s)"
  [[ -z "${started_epoch}" ]] || (( now_epoch - started_epoch > PPE_WORKFLOW_LOCK_TTL_MINUTES * 60 ))
}

# Retrying a cancelled Zadig task re-enters this script under the same TASK_ID.
# Zadig never runs two attempts of one task at once, so a lock stamped with our
# own task id belongs to an attempt that is already dead: take it over instead
# of deadlocking the retry against itself. See MUL-303.
workflow_lock_is_own_task() {
  local slot="$1" holder
  [[ -n "${TASK_ID:-}" ]] || return 1
  holder="$("${kubectl_bin}" -n "$(slot_namespace "${slot}")" get configmap "${workflow_lock_name}" \
    -o jsonpath='{.data.task}' 2>/dev/null || true)"
  [[ "${holder}" == "${TASK_ID}" ]]
}

slot_has_active_workflow() {
  local slot="$1" slot_ns
  slot_ns="$(slot_namespace "${slot}")"
  if ! "${kubectl_bin}" -n "${slot_ns}" get configmap "${workflow_lock_name}" >/dev/null 2>&1; then
    return 1
  fi
  if workflow_lock_is_stale "${slot}"; then
    "${kubectl_bin}" -n "${slot_ns}" delete configmap "${workflow_lock_name}" --ignore-not-found >/dev/null
    return 1
  fi
  return 0
}

create_lease() {
  local slot="$1" slot_ns url
  slot_ns="$(slot_namespace "${slot}")"
  url="$(slot_url "${slot}")"
  if slot_has_active_workflow "${slot}" || managed_resources_exist "${slot}"; then
    return 1
  fi
  "${kubectl_bin}" -n "${slot_ns}" create configmap "${lease_name}" \
    --from-literal="lease_id=${lease_id}" \
    --from-literal="issue_key=${ISSUE_KEY}" \
    --from-literal="commit=${GIT_COMMIT}" \
    --from-literal="mode=${PPE_MODE}" \
    --from-literal="state=provisioning" \
    --from-literal="task=${TASK_ID:-unknown}" \
    --from-literal="url=${url}" \
    --from-literal="allocated_at=$(date -u +%FT%TZ)" \
    --from-literal="expires_at=${expires_at}" >/dev/null 2>&1
}

acquire_allocation_lock() {
  local attempt started_at started_epoch now_epoch
  for attempt in $(seq 1 12); do
    if "${kubectl_bin}" -n "${allocation_lock_namespace}" create configmap "${allocation_lock_name}" \
      --from-literal="owner=${allocation_lock_owner}" \
      --from-literal="started_at=$(date -u +%FT%TZ)" >/dev/null 2>&1; then
      allocation_lock_acquired=1
      return
    fi
    started_at="$("${kubectl_bin}" -n "${allocation_lock_namespace}" get configmap "${allocation_lock_name}" \
      -o jsonpath='{.data.started_at}' 2>/dev/null || true)"
    started_epoch="$(date -u -d "${started_at}" +%s 2>/dev/null || true)"
    now_epoch="$(date -u +%s)"
    if [[ -z "${started_epoch}" ]] || (( now_epoch - started_epoch > PPE_ALLOCATION_LOCK_TTL_MINUTES * 60 )); then
      "${kubectl_bin}" -n "${allocation_lock_namespace}" delete configmap "${allocation_lock_name}" \
        --ignore-not-found >/dev/null
      continue
    fi
    sleep 5
  done
  printf 'Timed out waiting for the PPE allocation lock\n' >&2
  exit 75
}

select_slot() {
  local existing_slot candidate candidates
  acquire_allocation_lock
  existing_slot="$(find_issue_slot)"
  if [[ -n "${existing_slot}" ]]; then
    if [[ "${PPE_SLOT}" != "auto" && "${PPE_SLOT}" != "${existing_slot}" ]]; then
      printf 'Issue %s already owns PPE slot %s\n' "${ISSUE_KEY}" "${existing_slot}" >&2
      exit 73
    fi
    PPE_SLOT="${existing_slot}"
    lease_id="$(lease_field "${PPE_SLOT}" lease_id)"
    cleanup_allocation_lock
    return
  fi
  if [[ "${PPE_ACTION}" != "deploy" ]]; then
    printf 'Issue %s has no active PPE lease\n' "${ISSUE_KEY}" >&2
    exit 66
  fi

  lease_id="$(openssl rand -hex 16)"
  expires_at="$(date -u -d "+${PPE_TTL_HOURS} hours" +%FT%TZ)"
  if [[ "${PPE_SLOT}" == "auto" ]]; then
    candidates="$(seq 1 "${PPE_MAX_ENVIRONMENTS}")"
  else
    candidates="${PPE_SLOT}"
  fi
  for candidate in ${candidates}; do
    if create_lease "${candidate}"; then
      PPE_SLOT="${candidate}"
      lease_created=1
      cleanup_allocation_lock
      return
    fi
  done
  printf 'No PPE slot is available; all %s slots are leased or changing\n' "${PPE_MAX_ENVIRONMENTS}" >&2
  exit 75
}

gc_lock_is_active() {
  local started_at started_epoch now_epoch max_age_seconds
  if ! "${kubectl_bin}" -n "${namespace}" get configmap "${gc_lock_name}" >/dev/null 2>&1; then
    return 1
  fi
  started_at="$("${kubectl_bin}" -n "${namespace}" get configmap "${gc_lock_name}" \
    -o jsonpath='{.data.started_at}' 2>/dev/null || true)"
  started_epoch="$(date -u -d "${started_at}" +%s 2>/dev/null || true)"
  now_epoch="$(date -u +%s)"
  max_age_seconds="$((PPE_GC_LOCK_TTL_MINUTES * 60))"
  if [[ -n "${started_epoch}" ]] && (( now_epoch - started_epoch <= max_age_seconds )); then
    return 0
  fi
  "${kubectl_bin}" -n "${namespace}" delete configmap "${gc_lock_name}" --ignore-not-found >/dev/null
  return 1
}

rollback_new_lease() {
  if [[ "${lease_created}" == "1" && "$(lease_field "${PPE_SLOT}" lease_id)" == "${lease_id}" ]]; then
    "${kubectl_bin}" -n "${namespace}" delete configmap "${lease_name}" --ignore-not-found >/dev/null
  fi
}

acquire_workflow_lock() {
  if gc_lock_is_active; then
    rollback_new_lease
    printf 'PPE slot %s is being reclaimed by the TTL collector\n' "${PPE_SLOT}" >&2
    exit 75
  fi
  if "${kubectl_bin}" -n "${namespace}" create configmap "${workflow_lock_name}" \
    --from-literal="task=${TASK_ID:-unknown}" \
    --from-literal="action=${PPE_ACTION}" \
    --from-literal="started_at=$(date -u +%FT%TZ)" >/dev/null 2>&1; then
    workflow_lock_acquired=1
    if gc_lock_is_active; then
      cleanup_lock
      workflow_lock_acquired=0
      rollback_new_lease
      printf 'PPE slot %s entered TTL collection while the workflow was starting\n' "${PPE_SLOT}" >&2
      exit 75
    fi
    return
  fi
  if workflow_lock_is_stale "${PPE_SLOT}" || workflow_lock_is_own_task "${PPE_SLOT}"; then
    "${kubectl_bin}" -n "${namespace}" delete configmap "${workflow_lock_name}" --ignore-not-found >/dev/null
    if "${kubectl_bin}" -n "${namespace}" create configmap "${workflow_lock_name}" \
      --from-literal="task=${TASK_ID:-unknown}" \
      --from-literal="action=${PPE_ACTION}" \
      --from-literal="started_at=$(date -u +%FT%TZ)" >/dev/null 2>&1; then
      workflow_lock_acquired=1
      if gc_lock_is_active; then
        cleanup_lock
        workflow_lock_acquired=0
        rollback_new_lease
        printf 'PPE slot %s entered TTL collection while the workflow was starting\n' "${PPE_SLOT}" >&2
        exit 75
      fi
      return
    fi
  fi
  rollback_new_lease
  printf 'PPE slot %s is already being changed by another workflow (lock held by task %s since %s)\n' \
    "${PPE_SLOT}" \
    "$("${kubectl_bin}" -n "${namespace}" get configmap "${workflow_lock_name}" -o jsonpath='{.data.task}' 2>/dev/null || printf 'unknown')" \
    "$("${kubectl_bin}" -n "${namespace}" get configmap "${workflow_lock_name}" -o jsonpath='{.data.started_at}' 2>/dev/null || printf 'unknown')" >&2
  exit 75
}

emit_result() {
  local state="$1"
  printf 'PPE_RESULT={"state":"%s","issue":"%s","slot":%s,"lease_id":"%s","url":"%s","commit":"%s","mode":"%s","expires_at":"%s"}\n' \
    "${state}" "${ISSUE_KEY}" "${PPE_SLOT}" "${lease_id}" "$(slot_url "${PPE_SLOT}")" \
    "${GIT_COMMIT:-}" "${PPE_MODE:-}" "${expires_at:-}"
}

if [[ "${PPE_ACTION}" == "status" ]]; then
  found=0
  for PPE_SLOT in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
    ISSUE_KEY="$(lease_field "${PPE_SLOT}" issue_key)"
    [[ -n "${ISSUE_KEY}" ]] || continue
    lease_id="$(lease_field "${PPE_SLOT}" lease_id)"
    GIT_COMMIT="$(lease_field "${PPE_SLOT}" commit)"
    PPE_MODE="$(lease_field "${PPE_SLOT}" mode)"
    expires_at="$(lease_field "${PPE_SLOT}" expires_at)"
    lease_state="$(lease_field "${PPE_SLOT}" state)"
    emit_result "${lease_state:-provisioning}"
    found=1
  done
  [[ "${found}" == "1" ]] || printf 'PPE_RESULT={"state":"empty","leases":[]}\n'
  exit 0
fi

: "${ISSUE_KEY:?ISSUE_KEY is required}"
[[ "${ISSUE_KEY}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || { printf 'invalid ISSUE_KEY\n' >&2; exit 64; }

if [[ "${PPE_ACTION}" == "deploy" ]]; then
  : "${GIT_COMMIT:?GIT_COMMIT is required for deploy}"
  : "${PPE_MODE:?PPE_MODE is required for deploy}"
  : "${PPE_FAKE_ACP_BASE64:?PPE_FAKE_ACP_BASE64 is required for deploy}"
  [[ "${GIT_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || { printf 'GIT_COMMIT must be a full 40-character SHA\n' >&2; exit 64; }
  case "${PPE_MODE}" in
    platform|platform-daemon) ;;
    *) printf 'invalid PPE_MODE: %s\n' "${PPE_MODE}" >&2; exit 64 ;;
  esac
else
  : "${PPE_LEASE_ID:?PPE_LEASE_ID is required for ${PPE_ACTION}}"
  [[ "${PPE_LEASE_ID}" =~ ^[a-f0-9]{32}$ ]] || { printf 'invalid PPE_LEASE_ID\n' >&2; exit 64; }
fi

select_slot
namespace="$(slot_namespace "${PPE_SLOT}")"
node_port="$((32100 + PPE_SLOT))"
expires_at="$(lease_field "${PPE_SLOT}" expires_at)"
acquire_workflow_lock
start_lock_heartbeat

[[ "$(lease_field "${PPE_SLOT}" issue_key)" == "${ISSUE_KEY}" ]] || { printf 'PPE lease owner changed\n' >&2; exit 73; }
[[ "$(lease_field "${PPE_SLOT}" lease_id)" == "${lease_id}" ]] || { printf 'PPE lease identity changed\n' >&2; exit 73; }
if [[ "${PPE_ACTION}" != "deploy" && "${PPE_LEASE_ID}" != "${lease_id}" ]]; then
  printf 'PPE lease ID does not match Issue %s\n' "${ISSUE_KEY}" >&2
  exit 73
fi
if [[ "${PPE_ACTION}" == "deploy" ]]; then
  emit_result provisioning
fi

delete_managed_resources() {
  "${kubectl_bin}" -n "${namespace}" delete deployment,statefulset,service,job,configmap,secret,persistentvolumeclaim \
    -l "${managed_label}" --ignore-not-found --wait=true
}

if [[ "${PPE_ACTION}" == "release" ]]; then
  delete_managed_resources
  "${kubectl_bin}" -n "${namespace}" delete configmap "${lease_name}" --ignore-not-found >/dev/null
  expires_at=""
  emit_result released
  exit 0
fi

expires_at="$(date -u -d "+${PPE_TTL_HOURS} hours" +%FT%TZ)"
if [[ "${PPE_ACTION}" == "extend" ]]; then
  "${kubectl_bin}" -n "${namespace}" patch configmap "${lease_name}" --type merge \
    -p "{\"data\":{\"expires_at\":\"${expires_at}\",\"task\":\"${TASK_ID:-unknown}\"}}" >/dev/null
  emit_result extended
  exit 0
fi

"${kubectl_bin}" -n "${namespace}" patch configmap "${lease_name}" --type merge \
  -p "{\"data\":{\"commit\":\"${GIT_COMMIT}\",\"mode\":\"${PPE_MODE}\",\"state\":\"provisioning\",\"task\":\"${TASK_ID:-unknown}\",\"expires_at\":\"${expires_at}\"}}" >/dev/null

registry="${PPE_REGISTRY_HOST}/multiremi-ppe"
api_image="${registry}/api:${GIT_COMMIT}"
web_image="${registry}/web:${GIT_COMMIT}"
git_context="git://github.com/Grassgod/Remi.git#${GIT_COMMIT}"

delete_managed_resources

registry_manifest_exists() {
  local repository="$1"
  curl --noproxy '*' -fsS -o /dev/null \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://${PPE_REGISTRY_HOST}/v2/multiremi-ppe/${repository}/manifests/${GIT_COMMIT}"
}

run_build() {
  local name="$1" dockerfile="$2" destination="$3" memory_limit="$4" build_args="${5:-}"
  local build_arg_yaml="" build_arg
  for build_arg in ${build_args}; do
    build_arg_yaml+="        - --build-arg=${build_arg}"$'\n'
  done
  build_arg_yaml="${build_arg_yaml%$'\n'}"
  cat <<YAML | "${kubectl_bin}" -n "${namespace}" apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  labels:
    multiremi.io/managed: "true"
    multiremi.io/component: build
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        multiremi.io/managed: "true"
        multiremi.io/component: build
    spec:
      restartPolicy: Never
      containers:
      - name: kaniko
        image: ${PPE_KANIKO_IMAGE}
        args:
        - --context=${git_context}
        - --dockerfile=${dockerfile}
        - --destination=${destination}
        - --cache=true
        - --cache-repo=${registry}/cache
        - --insecure
        - --skip-tls-verify
${build_arg_yaml}
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
          limits:
            cpu: "3"
            memory: ${memory_limit}
YAML
}

build_job_condition() {
  local job="$1" condition="$2"
  [[ "$("${kubectl_bin}" -n "${namespace}" get "job/${job}" \
    -o "jsonpath={.status.conditions[?(@.type=='${condition}')].status}" 2>/dev/null || true)" == "True" ]]
}

build_job_progress() {
  local job="$1" pod reason
  pod="$("${kubectl_bin}" -n "${namespace}" get pod -l "job-name=${job}" \
    --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -n 1)"
  [[ -n "${pod}" ]] || { printf 'no pod yet'; return; }
  reason="$("${kubectl_bin}" -n "${namespace}" get "${pod}" \
    -o jsonpath='{.status.phase}{" "}{.status.containerStatuses[0].state.terminated.reason}' 2>/dev/null || true)"
  printf '%s %s | %s' "${pod#pod/}" "${reason}" \
    "$("${kubectl_bin}" -n "${namespace}" logs "${pod}" --tail=1 2>/dev/null | tr -d '\r' | tail -c 160)"
}

# kubectl wait only settles on the condition it was given, so waiting on a
# Job's Complete condition never returns for a Job that ends up Failed: an
# OOM-killed build used to leave the workflow silent until the 45m timeout.
# Poll both terminal conditions and print progress in between, so a stuck build
# is visible in the log rather than inferred from silence.
wait_for_build() {
  local job="$1" started="${SECONDS}" elapsed
  while true; do
    if build_job_condition "${job}" Complete; then
      printf '%s completed after %ss\n' "${job}" "$((SECONDS - started))"
      return 0
    fi
    if build_job_condition "${job}" Failed; then
      printf '%s failed after %ss\n' "${job}" "$((SECONDS - started))" >&2
      return 1
    fi
    elapsed="$((SECONDS - started))"
    if (( elapsed > PPE_BUILD_TIMEOUT_SECONDS )); then
      printf '%s did not finish within %ss\n' "${job}" "${PPE_BUILD_TIMEOUT_SECONDS}" >&2
      return 1
    fi
    printf '[%ss] %s: %s\n' "${elapsed}" "${job}" "$(build_job_progress "${job}")"
    sleep "${PPE_BUILD_PROGRESS_SECONDS}"
  done
}

build_jobs=()
if registry_manifest_exists api; then
  printf 'Reusing API image for commit %s\n' "${GIT_COMMIT}"
else
  run_build ppe-build-api deploy/docker/Dockerfile.api "${api_image}" "${PPE_API_BUILD_MEMORY}"
  build_jobs+=(ppe-build-api)
fi
if registry_manifest_exists web; then
  printf 'Reusing Web image for commit %s\n' "${GIT_COMMIT}"
else
  run_build ppe-build-web deploy/docker/Dockerfile.web "${web_image}" "${PPE_WEB_BUILD_MEMORY}" \
    "REMOTE_API_URL=http://api:6120 NEXT_BUILD_CPUS=${PPE_WEB_BUILD_CPUS}"
  build_jobs+=(ppe-build-web)
fi

build_failed=0
for build_job in "${build_jobs[@]}"; do
  if ! wait_for_build "${build_job}"; then
    "${kubectl_bin}" -n "${namespace}" logs "job/${build_job}" --all-containers --tail=300 || true
    "${kubectl_bin}" -n "${namespace}" get pod -l "job-name=${build_job}" \
      -o custom-columns=POD:.metadata.name,PHASE:.status.phase,REASON:.status.containerStatuses[0].state.terminated.reason || true
    build_failed=1
    break
  fi
  "${kubectl_bin}" -n "${namespace}" logs "job/${build_job}" --all-containers --tail=80
done
if [[ "${build_failed}" == "1" ]]; then
  exit 1
fi

postgres_password="$(openssl rand -hex 24)"
jwt_secret="$(openssl rand -hex 32)"
"${kubectl_bin}" -n "${namespace}" create secret generic ppe-secrets \
  --from-literal=postgres-password="${postgres_password}" \
  --from-literal=jwt-secret="${jwt_secret}" \
  --dry-run=client -o yaml |
  "${kubectl_bin}" label --local -f - "${managed_label}" -o yaml |
  "${kubectl_bin}" apply -f -

fake_acp_file="${PWD}/.ppe-bin/fake-acp.ts"
printf '%s' "${PPE_FAKE_ACP_BASE64}" | base64 -d > "${fake_acp_file}"
chmod 0755 "${fake_acp_file}"
"${kubectl_bin}" -n "${namespace}" create configmap ppe-fake-acp \
  --from-file=fake-acp.ts="${fake_acp_file}" \
  --dry-run=client -o yaml |
  "${kubectl_bin}" label --local -f - "${managed_label}" -o yaml |
  "${kubectl_bin}" apply -f -

daemon_replicas=0
if [[ "${PPE_MODE}" == "platform-daemon" ]]; then daemon_replicas=1; fi

cat <<YAML | "${kubectl_bin}" -n "${namespace}" apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  labels: { multiremi.io/managed: "true" }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 8Gi } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: multiremi-data
  labels: { multiremi.io/managed: "true" }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 8Gi } }
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  labels: { multiremi.io/managed: "true" }
spec:
  selector: { app: postgres }
  ports: [{ name: postgres, port: 5432, targetPort: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  labels: { multiremi.io/managed: "true" }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres, multiremi.io/managed: "true" } }
    spec:
      containers:
      - name: postgres
        image: pgvector/pgvector:pg17
        env:
        - { name: POSTGRES_DB, value: multiremi }
        - { name: POSTGRES_USER, value: multiremi }
        - name: POSTGRES_PASSWORD
          valueFrom: { secretKeyRef: { name: ppe-secrets, key: postgres-password } }
        ports: [{ containerPort: 5432 }]
        readinessProbe: { exec: { command: [sh, -c, pg_isready -U multiremi -d multiremi] }, initialDelaySeconds: 5, periodSeconds: 5 }
        resources:
          requests: { cpu: 250m, memory: 512Mi }
          limits: { cpu: "1", memory: 2Gi }
        volumeMounts: [{ name: data, mountPath: /var/lib/postgresql/data }]
      volumes: [{ name: data, persistentVolumeClaim: { claimName: postgres-data } }]
---
apiVersion: v1
kind: Service
metadata:
  name: api
  labels: { multiremi.io/managed: "true" }
spec:
  selector: { app: api }
  ports: [{ name: http, port: 6120, targetPort: 6120 }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels: { multiremi.io/managed: "true" }
  annotations:
    multiremi.io/commit: "${GIT_COMMIT}"
    multiremi.io/mode: "${PPE_MODE}"
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api, multiremi.io/managed: "true" } }
    spec:
      securityContext: { fsGroup: 1000 }
      initContainers:
      - name: wait-for-postgres
        image: pgvector/pgvector:pg17
        command: [sh, -lc]
        args:
        - >-
          until pg_isready -h postgres -U multiremi -d multiremi;
          do sleep 2; done
      containers:
      - name: api
        image: ${api_image}
        imagePullPolicy: Always
        env:
        - { name: HOME, value: /srv/multiremi }
        - { name: NODE_ENV, value: development }
        - { name: MULTIREMI_HOST, value: 0.0.0.0 }
        - { name: MULTIREMI_PORT, value: "6120" }
        - { name: MULTIREMI_BACKGROUND_JOBS, value: "0" }
        - { name: MULTIREMI_PROJECT_KNOWLEDGE_MODE, value: sql }
        - { name: MULTIREMI_SSH_MESH_CONTROL_PLANE, value: "0" }
        - name: POSTGRES_PASSWORD
          valueFrom: { secretKeyRef: { name: ppe-secrets, key: postgres-password } }
        - name: MULTIREMI_DATABASE_URL
          value: postgresql://multiremi:\$(POSTGRES_PASSWORD)@postgres:5432/multiremi
        - name: JWT_SECRET
          valueFrom: { secretKeyRef: { name: ppe-secrets, key: jwt-secret } }
        ports: [{ containerPort: 6120 }]
        readinessProbe: { httpGet: { path: /readyz, port: 6120 }, initialDelaySeconds: 10, periodSeconds: 5 }
        resources:
          requests: { cpu: 500m, memory: 1Gi }
          limits: { cpu: "2", memory: 3Gi }
        volumeMounts: [{ name: data, mountPath: /srv/multiremi }]
      volumes: [{ name: data, persistentVolumeClaim: { claimName: multiremi-data } }]
---
apiVersion: v1
kind: Service
metadata:
  name: web
  labels: { multiremi.io/managed: "true" }
spec:
  type: NodePort
  selector: { app: web }
  ports: [{ name: http, port: 3000, targetPort: 3000, nodePort: ${node_port} }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: { multiremi.io/managed: "true" }
  annotations: { multiremi.io/commit: "${GIT_COMMIT}" }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web, multiremi.io/managed: "true" } }
    spec:
      containers:
      - name: web
        image: ${web_image}
        imagePullPolicy: Always
        ports: [{ containerPort: 3000 }]
        readinessProbe: { httpGet: { path: /login, port: 3000 }, initialDelaySeconds: 5, periodSeconds: 5 }
        resources:
          requests: { cpu: 250m, memory: 256Mi }
          limits: { cpu: "1", memory: 1Gi }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daemon
  labels: { multiremi.io/managed: "true" }
  annotations: { multiremi.io/commit: "${GIT_COMMIT}" }
spec:
  replicas: ${daemon_replicas}
  selector: { matchLabels: { app: daemon } }
  template:
    metadata: { labels: { app: daemon, multiremi.io/managed: "true" } }
    spec:
      securityContext: { fsGroup: 1000 }
      initContainers:
      - name: wait-for-api
        image: ${api_image}
        command: [bun, -e]
        args:
        - >-
          for (let attempt = 0; attempt < 90; attempt++) {
            try {
              const response = await fetch("http://api:6120/readyz");
              if (response.ok) process.exit(0);
            } catch {}
            await Bun.sleep(2000);
          }
          process.exit(1);
      - name: prepare-fake-codex-home
        image: ${api_image}
        command: [sh, -lc]
        args:
        - >-
          install -d -m 0700 /srv/multiremi/.codex &&
          printf '%s\n' '{"auth_mode":"chatgpt","tokens":{"access_token":"ppe-fake-acp-only"}}' > /srv/multiremi/.codex/auth.json &&
          chmod 0600 /srv/multiremi/.codex/auth.json
        volumeMounts: [{ name: data, mountPath: /srv/multiremi }]
      containers:
      - name: daemon
        image: ${api_image}
        imagePullPolicy: Always
        command: [bun, apps/remi/main.ts, daemon, start, --foreground]
        env:
        - { name: HOME, value: /srv/multiremi }
        - { name: CODEX_HOME, value: /srv/multiremi/.codex }
        - { name: MULTIREMI_SERVER_URL, value: http://api:6120 }
        - { name: MULTIREMI_PROVIDER, value: codex }
        - { name: MULTIREMI_RUNTIME_ID, value: ppe-${PPE_SLOT}-codex }
        - { name: MULTIREMI_RUNTIME_NAME, value: PPE-${PPE_SLOT}-daemon }
        - { name: MULTIREMI_DEVICE_NAME, value: PPE-${PPE_SLOT} }
        - { name: MULTIREMI_WORKSPACE_ID, value: local }
        - { name: MULTIREMI_MAX_CONCURRENCY, value: "1" }
        - { name: REMI_CODEX_AGENT_ACP_EXECUTABLE, value: /ppe/fake-acp.ts }
        resources:
          requests: { cpu: 250m, memory: 512Mi }
          limits: { cpu: "1", memory: 2Gi }
        volumeMounts:
        - { name: data, mountPath: /srv/multiremi }
        - { name: fake-acp, mountPath: /ppe, readOnly: true }
      volumes:
      - { name: data, emptyDir: {} }
      - name: fake-acp
        configMap: { name: ppe-fake-acp, defaultMode: 493 }
YAML

"${kubectl_bin}" -n "${namespace}" rollout status statefulset/postgres --timeout=5m
"${kubectl_bin}" -n "${namespace}" rollout status deployment/api --timeout=10m
"${kubectl_bin}" -n "${namespace}" rollout status deployment/web --timeout=5m
if [[ "${PPE_MODE}" == "platform-daemon" ]]; then
  "${kubectl_bin}" -n "${namespace}" rollout status deployment/daemon --timeout=10m
  seed_output="$(timeout 20s "${kubectl_bin}" -n "${namespace}" exec deployment/api -- \
    bun apps/remi/main.ts agent default --provider codex 2>&1)" || seed_status=$?
  seed_status="${seed_status:-0}"
  printf '%s\n' "${seed_output}"
  if [[ "${seed_status}" != "0" && "${seed_status}" != "124" ]]; then
    printf 'Failed to create the default PPE agent (exit %s)\n' "${seed_status}" >&2
    exit "${seed_status}"
  fi
fi

api_digest="$(${kubectl_bin} -n "${namespace}" get pod -l app=api -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')"
web_digest="$(${kubectl_bin} -n "${namespace}" get pod -l app=web -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')"
expires_at="$(date -u -d "+${PPE_TTL_HOURS} hours" +%FT%TZ)"
"${kubectl_bin}" -n "${namespace}" patch configmap "${lease_name}" --type merge \
  -p "{\"data\":{\"state\":\"active\",\"expires_at\":\"${expires_at}\"}}" >/dev/null
deploy_succeeded=1
printf 'PPE slot: %s\nCommit: %s\nMode: %s\nURL: %s\nExpires: %s\nAPI image: %s\nWeb image: %s\n' \
  "${PPE_SLOT}" "${GIT_COMMIT}" "${PPE_MODE}" "$(slot_url "${PPE_SLOT}")" "${expires_at}" "${api_digest}" "${web_digest}"
emit_result active
