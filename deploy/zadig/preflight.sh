#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

log() { printf '[zadig-preflight] %s\n' "$*"; }
die() { printf '[zadig-preflight] ERROR: %s\n' "$*" >&2; exit 1; }

for command_name in curl docker ip jq node npm openssl sha256sum ss tar; do
  command -v "${command_name}" >/dev/null 2>&1 || die "missing command: ${command_name}"
done

[[ "${ZADIG_ROOT}" == /data00/multiremi/zadig ]] || die "unexpected ZADIG_ROOT: ${ZADIG_ROOT}"
[[ "${ZADIG_NODE_PORT}" =~ ^[0-9]+$ ]] || die "ZADIG_NODE_PORT must be numeric"
(( ZADIG_NODE_PORT >= 30000 && ZADIG_NODE_PORT <= 32767 )) || die "ZADIG_NODE_PORT must be a NodePort"
[[ "${ZADIG_PUBLIC_HOST}" =~ ^[A-Za-z0-9.-]+$ ]] || die "ZADIG_PUBLIC_HOST is invalid"
[[ "${ZADIG_PUBLIC_PORT}" =~ ^[0-9]+$ ]] || die "ZADIG_PUBLIC_PORT must be numeric"
(( ZADIG_PUBLIC_PORT >= 1 && ZADIG_PUBLIC_PORT <= 65535 )) || die "ZADIG_PUBLIC_PORT is invalid"
[[ "${PPE_MAX_ENVIRONMENTS}" == "6" ]] || die "PPE slot count must remain 6"
[[ "${PPE_BUILD_CONCURRENCY}" == "3" ]] || die "PPE build concurrency must remain 3"
[[ "${PPE_TTL_HOURS}" == "24" ]] || die "PPE TTL must remain 24 hours"
[[ "${PPE_ALLOCATION_LOCK_TTL_MINUTES}" =~ ^[0-9]+$ ]] || die "PPE allocation lock TTL must be numeric"
[[ "${PPE_WORKFLOW_LOCK_TTL_MINUTES}" =~ ^[0-9]+$ ]] || die "PPE workflow lock TTL must be numeric"
[[ "${PPE_GC_LOCK_TTL_MINUTES}" =~ ^[0-9]+$ ]] || die "PPE GC lock TTL must be numeric"
[[ "${PPE_GC_IMAGE}" == *@sha256:* ]] || die "PPE GC image must be digest-pinned"
[[ -n "${PPE_GC_SCHEDULE}" ]] || die "PPE GC schedule is required"

cpu_count="$(nproc)"
memory_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
data_available_kib="$(df -Pk /data00 | awk 'NR == 2 { print $4 }')"

(( cpu_count >= 8 )) || die "at least 8 CPUs are required; found ${cpu_count}"
(( memory_kib >= 16 * 1024 * 1024 )) || die "at least 16 GiB memory is required"
(( data_available_kib >= 50 * 1024 * 1024 )) || die "at least 50 GiB must be free on /data00"

if ip -4 route show | awk '{ print $1 }' | grep -Fxq "${K3S_CLUSTER_CIDR}" && ! systemctl is-active --quiet k3s; then
  die "cluster CIDR ${K3S_CLUSTER_CIDR} is already routed by another service"
fi
if ip -4 route show | awk '{ print $1 }' | grep -Fxq "${K3S_SERVICE_CIDR}" && ! systemctl is-active --quiet k3s; then
  die "service CIDR ${K3S_SERVICE_CIDR} is already routed by another service"
fi

for port in 6443 "${ZADIG_NODE_PORT}" "${PPE_REGISTRY_NODE_PORT}"; do
  if ss -lntH | awk '{ print $4 }' | grep -Eq ":${port}$" && ! systemctl is-active --quiet k3s; then
    die "TCP port ${port} is already in use"
  fi
done

unhealthy_containers="$(docker ps --filter health=unhealthy --format '{{.Names}}')"
[[ -z "${unhealthy_containers}" ]] || die "existing Docker containers are unhealthy: ${unhealthy_containers//$'\n'/, }"

log "CPU=${cpu_count}, memory=$((memory_kib / 1024 / 1024))GiB, /data00 free=$((data_available_kib / 1024 / 1024))GiB"
log "pod CIDR=${K3S_CLUSTER_CIDR}, service CIDR=${K3S_SERVICE_CIDR}, Zadig public=${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}, NodePort=${ZADIG_NODE_PORT}"
log "preflight passed"
