#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

KUBECONFIG_PATH="/etc/rancher/k3s/k3s.yaml"

log() { printf '[zadig-verify] %s\n' "$*"; }
die() { printf '[zadig-verify] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -r "${KUBECONFIG_PATH}" ]] || die "cannot read ${KUBECONFIG_PATH}; run with sudo"
export KUBECONFIG="${KUBECONFIG_PATH}"

systemctl is-active --quiet k3s || die "k3s is not active"
[[ "$(kubectl get node -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')" == "True" ]] || die "k3s node is not ready"

release_status="$(helm status "${ZADIG_RELEASE_NAME}" -n "${ZADIG_NAMESPACE}" -o json | jq -r '.info.status')"
[[ "${release_status}" == "deployed" ]] || die "Zadig Helm release status is ${release_status}"

bad_pods="$(kubectl -n "${ZADIG_NAMESPACE}" get pods -o json | jq -r '.items[] | select(.status.phase != "Running" and .status.phase != "Succeeded") | .metadata.name + "=" + .status.phase')"
[[ -z "${bad_pods}" ]] || die "Zadig pods are not ready: ${bad_pods//$'\n'/, }"

registry_ready="$(kubectl -n "${PPE_REGISTRY_NAMESPACE}" get deployment registry -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
[[ "${registry_ready}" == "1" ]] || die "PPE registry is not ready"
registry_port="$(kubectl -n "${PPE_REGISTRY_NAMESPACE}" get service registry -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)"
[[ "${registry_port}" == "${PPE_REGISTRY_NODE_PORT}" ]] || die "expected registry NodePort ${PPE_REGISTRY_NODE_PORT}, found ${registry_port:-none}"
curl --noproxy '*' -fsS --max-time 10 "http://${ZADIG_NODE_IP}:${PPE_REGISTRY_NODE_PORT}/v2/" >/dev/null || die "PPE registry HTTP check failed"

actual_node_port="$(kubectl -n "${ZADIG_NAMESPACE}" get service gateway-proxy -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}' 2>/dev/null || true)"
if [[ -z "${actual_node_port}" ]]; then
  actual_node_port="$(kubectl -n "${ZADIG_NAMESPACE}" get service -l app=gateway-proxy -o jsonpath='{.items[0].spec.ports[0].nodePort}' 2>/dev/null || true)"
fi
[[ "${actual_node_port}" == "${ZADIG_NODE_PORT}" ]] || die "expected NodePort ${ZADIG_NODE_PORT}, found ${actual_node_port:-none}"

slot_count="$(kubectl get namespace -l multiremi.io/purpose=ppe -o json | jq '.items | length')"
[[ "${slot_count}" == "${PPE_MAX_ENVIRONMENTS}" ]] || die "expected ${PPE_MAX_ENVIRONMENTS} PPE slots, found ${slot_count}"

gc_schedule="$(kubectl -n "${ZADIG_NAMESPACE}" get cronjob multiremi-ppe-gc -o jsonpath='{.spec.schedule}' 2>/dev/null || true)"
[[ "${gc_schedule}" == "${PPE_GC_SCHEDULE}" ]] || die "PPE GC schedule is ${gc_schedule:-missing}"
gc_image="$(kubectl -n "${ZADIG_NAMESPACE}" get cronjob multiremi-ppe-gc -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
[[ "${gc_image}" == "${PPE_GC_IMAGE}" ]] || die "PPE GC image does not match the pinned image"
[[ "$(kubectl -n "${ZADIG_NAMESPACE}" get configmap multiremi-ppe-gc-script -o name 2>/dev/null || true)" == "configmap/multiremi-ppe-gc-script" ]] || die "PPE GC script is missing"

http_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://${ZADIG_NODE_IP}:${ZADIG_NODE_PORT}/" || true)"
case "${http_code}" in
  200|301|302) ;;
  *) die "Zadig HTTP check returned ${http_code}" ;;
esac

public_url="http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}"
public_http_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 "${public_url}/" || true)"
[[ "${public_http_code}" == "200" ]] || die "Zadig public endpoint returned HTTP ${public_http_code}"
ci_redirect="$(curl --noproxy '*' -sS -o /dev/null -w '%{redirect_url}' --max-time 10 "http://${ZADIG_PUBLIC_HOST}/ci" || true)"
[[ "${ci_redirect}" == "${public_url}/" ]] || die "/ci redirects to ${ci_redirect:-nowhere}"

admin_api_token_file="${ZADIG_ROOT}/secrets/admin-api-token"
[[ -s "${admin_api_token_file}" ]] || die "administrator API token is missing"
concurrency="$(
  curl --noproxy '*' -fsS \
    -H "Authorization: Bearer $(<"${admin_api_token_file}")" \
    "http://${ZADIG_NODE_IP}:${ZADIG_NODE_PORT}/api/aslan/system/concurrency/workflow"
)"
workflow_concurrency="$(jq -r '.workflow_concurrency' <<<"${concurrency}")"
build_concurrency="$(jq -r '.build_concurrency' <<<"${concurrency}")"
[[ "${workflow_concurrency}" == "${PPE_BUILD_CONCURRENCY}" ]] || die "workflow concurrency is ${workflow_concurrency}"
[[ "${build_concurrency}" == "${PPE_BUILD_CONCURRENCY}" ]] || die "task concurrency is ${build_concurrency}"

log "k3s node ready"
log "Zadig ${ZADIG_VERSION} deployed; HTTP ${http_code} on ${ZADIG_NODE_IP}:${ZADIG_NODE_PORT}"
log "public endpoint HTTP ${public_http_code} on ${public_url}; /ci redirect ready"
log "PPE registry ready on ${ZADIG_NODE_IP}:${PPE_REGISTRY_NODE_PORT}"
log "PPE slots=${slot_count}; TTL=${PPE_TTL_HOURS}h; workflow/task concurrency=${PPE_BUILD_CONCURRENCY}"
