#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

die() { printf '[zadig-remove] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run as root"
[[ "${CONFIRM_REMOVE_ZADIG:-}" == "remove-zadig-and-ppe" ]] || die "set CONFIRM_REMOVE_ZADIG=remove-zadig-and-ppe to continue"
[[ "${ZADIG_ROOT}" == /data00/multiremi/zadig ]] || die "unexpected ZADIG_ROOT: ${ZADIG_ROOT}"
[[ -r /etc/rancher/k3s/k3s.yaml ]] || die "k3s kubeconfig is unavailable"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl -n "${ZADIG_NAMESPACE}" delete cronjob multiremi-ppe-gc --ignore-not-found --wait=true
kubectl -n "${ZADIG_NAMESPACE}" delete configmap multiremi-ppe-gc-script --ignore-not-found
kubectl -n "${ZADIG_NAMESPACE}" delete serviceaccount multiremi-ppe-gc --ignore-not-found
kubectl delete clusterrole multiremi-ppe-gc --ignore-not-found
helm uninstall "${ZADIG_RELEASE_NAME}" -n "${ZADIG_NAMESPACE}" --wait

kubectl delete namespace "${PPE_REGISTRY_NAMESPACE}" --ignore-not-found --wait=true

for index in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
  namespace="${PPE_NAMESPACE_PREFIX}${index}"
  kubectl delete namespace "${namespace}" --ignore-not-found --wait=true
done

printf '[zadig-remove] Zadig, PPE namespaces, and the PPE registry were removed; k3s and %s were retained\n' "${ZADIG_ROOT}"
