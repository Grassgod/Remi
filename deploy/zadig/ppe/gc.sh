#!/usr/bin/env bash

set -euo pipefail

: "${PPE_NAMESPACE_PREFIX:?PPE_NAMESPACE_PREFIX is required}"
: "${PPE_MAX_ENVIRONMENTS:?PPE_MAX_ENVIRONMENTS is required}"
: "${PPE_WORKFLOW_LOCK_TTL_MINUTES:?PPE_WORKFLOW_LOCK_TTL_MINUTES is required}"
: "${PPE_GC_LOCK_TTL_MINUTES:?PPE_GC_LOCK_TTL_MINUTES is required}"

managed_label="multiremi.io/managed=true"
lease_name="ppe-lease"
workflow_lock_name="ppe-workflow-lock"
gc_lock_name="ppe-gc-lock"
current_namespace=""

log() { printf '[ppe-gc] %s\n' "$*"; }

cleanup_gc_lock() {
  if [[ -n "${current_namespace}" ]]; then
    kubectl -n "${current_namespace}" delete configmap "${gc_lock_name}" --ignore-not-found >/dev/null 2>&1 || true
  fi
}
trap cleanup_gc_lock EXIT

epoch_or_empty() {
  date -u -d "$1" +%s 2>/dev/null || true
}

lock_is_active() {
  local namespace="$1" started_at started_epoch now_epoch max_age_seconds
  if ! kubectl -n "${namespace}" get configmap "${workflow_lock_name}" >/dev/null 2>&1; then
    return 1
  fi
  started_at="$(kubectl -n "${namespace}" get configmap "${workflow_lock_name}" -o jsonpath='{.data.started_at}' 2>/dev/null || true)"
  started_epoch="$(epoch_or_empty "${started_at}")"
  now_epoch="$(date -u +%s)"
  max_age_seconds="$((PPE_WORKFLOW_LOCK_TTL_MINUTES * 60))"
  if [[ -n "${started_epoch}" ]] && (( now_epoch - started_epoch <= max_age_seconds )); then
    return 0
  fi
  log "removing stale workflow lock from ${namespace}"
  kubectl -n "${namespace}" delete configmap "${workflow_lock_name}" --ignore-not-found >/dev/null
  return 1
}

gc_lock_is_active() {
  local namespace="$1" started_at started_epoch now_epoch max_age_seconds
  if ! kubectl -n "${namespace}" get configmap "${gc_lock_name}" >/dev/null 2>&1; then
    return 1
  fi
  started_at="$(kubectl -n "${namespace}" get configmap "${gc_lock_name}" -o jsonpath='{.data.started_at}' 2>/dev/null || true)"
  started_epoch="$(epoch_or_empty "${started_at}")"
  now_epoch="$(date -u +%s)"
  max_age_seconds="$((PPE_GC_LOCK_TTL_MINUTES * 60))"
  if [[ -n "${started_epoch}" ]] && (( now_epoch - started_epoch <= max_age_seconds )); then
    return 0
  fi
  log "removing stale GC lock from ${namespace}"
  kubectl -n "${namespace}" delete configmap "${gc_lock_name}" --ignore-not-found >/dev/null
  return 1
}

delete_managed_resources() {
  local namespace="$1"
  kubectl -n "${namespace}" delete \
    deployment,statefulset,service,job,configmap,secret,persistentvolumeclaim \
    -l "${managed_label}" --ignore-not-found --wait=true
}

now_epoch="$(date -u +%s)"
for slot in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
  namespace="${PPE_NAMESPACE_PREFIX}${slot}"
  if ! kubectl -n "${namespace}" get configmap "${lease_name}" >/dev/null 2>&1; then
    continue
  fi

  expires_at="$(kubectl -n "${namespace}" get configmap "${lease_name}" -o jsonpath='{.data.expires_at}' 2>/dev/null || true)"
  expires_epoch="$(epoch_or_empty "${expires_at}")"
  if [[ -z "${expires_epoch}" ]]; then
    log "skipping ${namespace}: lease has an invalid expires_at"
    continue
  fi
  if (( expires_epoch > now_epoch )); then
    continue
  fi
  if lock_is_active "${namespace}"; then
    log "skipping ${namespace}: workflow is active"
    continue
  fi

  if gc_lock_is_active "${namespace}"; then
    log "skipping ${namespace}: another collector owns the GC lock"
    continue
  fi

  current_namespace="${namespace}"
  if ! kubectl -n "${namespace}" create configmap "${gc_lock_name}" \
    --from-literal="started_at=$(date -u +%FT%TZ)" >/dev/null 2>&1; then
    log "skipping ${namespace}: another collector owns the GC lock"
    current_namespace=""
    continue
  fi

  lease_id="$(kubectl -n "${namespace}" get configmap "${lease_name}" -o jsonpath='{.data.lease_id}' 2>/dev/null || true)"
  current_expires_at="$(kubectl -n "${namespace}" get configmap "${lease_name}" -o jsonpath='{.data.expires_at}' 2>/dev/null || true)"
  current_expires_epoch="$(epoch_or_empty "${current_expires_at}")"
  current_epoch="$(date -u +%s)"
  if [[ -z "${lease_id}" || -z "${current_expires_epoch}" ]] || (( current_expires_epoch > current_epoch )); then
    cleanup_gc_lock
    current_namespace=""
    continue
  fi
  if lock_is_active "${namespace}"; then
    cleanup_gc_lock
    current_namespace=""
    continue
  fi

  issue_key="$(kubectl -n "${namespace}" get configmap "${lease_name}" -o jsonpath='{.data.issue_key}' 2>/dev/null || true)"
  log "reclaiming expired ${namespace} for ${issue_key:-unknown}"
  delete_managed_resources "${namespace}"
  if [[ "$(kubectl -n "${namespace}" get configmap "${lease_name}" -o jsonpath='{.data.lease_id}' 2>/dev/null || true)" == "${lease_id}" ]]; then
    kubectl -n "${namespace}" delete configmap "${lease_name}" --ignore-not-found >/dev/null
  fi
  cleanup_gc_lock
  current_namespace=""
done

log "TTL scan complete"
