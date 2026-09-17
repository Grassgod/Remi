#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

KUBECONFIG_PATH="/etc/rancher/k3s/k3s.yaml"
SECRETS_DIR="${ZADIG_ROOT}/secrets"
ENCRYPTION_KEY_FILE="${SECRETS_DIR}/encryption-key"

log() { printf '[zadig-install] %s\n' "$*"; }
die() { printf '[zadig-install] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run as root: sudo bash ${SCRIPT_DIR}/install.sh"
[[ "${ZADIG_ROOT}" == /data00/multiremi/zadig ]] || die "unexpected ZADIG_ROOT: ${ZADIG_ROOT}"

"${SCRIPT_DIR}/preflight.sh"

install -d -m 0755 "${ZADIG_ROOT}" "${ZADIG_ROOT}/downloads" "${ZADIG_ROOT}/logs"
install -d -m 0700 "${SECRETS_DIR}"

install_k3s() {
  local current_version=""
  if command -v k3s >/dev/null 2>&1; then
    current_version="$(k3s --version | awk 'NR == 1 { print $3 }')"
  fi
  if [[ "${current_version}" == "${K3S_VERSION}" ]]; then
    log "k3s ${K3S_VERSION} already installed"
  else
    local installer="${ZADIG_ROOT}/downloads/k3s-install.sh"
    curl -fsSL https://get.k3s.io -o "${installer}"
    printf '%s  %s\n' "${K3S_INSTALL_SCRIPT_SHA256}" "${installer}" | sha256sum -c -
    chmod 0755 "${installer}"
    INSTALL_K3S_VERSION="${K3S_VERSION}" \
      INSTALL_K3S_EXEC="server --data-dir ${ZADIG_ROOT}/k3s --cluster-cidr ${K3S_CLUSTER_CIDR} --service-cidr ${K3S_SERVICE_CIDR} --node-ip ${ZADIG_NODE_IP} --disable traefik --disable servicelb --write-kubeconfig-mode 0640" \
      "${installer}"
  fi

  systemctl enable --now k3s
  for _ in $(seq 1 90); do
    if k3s kubectl get nodes >/dev/null 2>&1 && [[ "$(k3s kubectl get node -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')" == "True" ]]; then
      log "k3s node is ready"
      return
    fi
    sleep 2
  done
  die "k3s did not become ready within 180 seconds"
}

install_helm() {
  local expected="${HELM_VERSION#v}"
  local current=""
  if command -v helm >/dev/null 2>&1; then
    current="$(helm version --template '{{.Version}}' 2>/dev/null || true)"
  fi
  if [[ "${current}" == "${HELM_VERSION}" ]]; then
    log "Helm ${HELM_VERSION} already installed"
    return
  fi

  local archive="${ZADIG_ROOT}/downloads/helm-${HELM_VERSION}-linux-amd64.tar.gz"
  local extract_dir
  extract_dir="$(mktemp -d "${ZADIG_ROOT}/downloads/helm.XXXXXX")"
  trap 'find "${extract_dir}" -xdev -depth -delete 2>/dev/null || true' RETURN
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" -o "${archive}"
  printf '%s  %s\n' "${HELM_TARBALL_SHA256}" "${archive}" | sha256sum -c -
  tar -xzf "${archive}" -C "${extract_dir}"
  install -m 0755 "${extract_dir}/linux-amd64/helm" /usr/local/bin/helm
  [[ "$(helm version --template '{{.Version}}')" == "${HELM_VERSION}" ]] || die "Helm ${expected} installation failed"
  find "${extract_dir}" -xdev -depth -delete
  trap - RETURN
  log "installed Helm ${HELM_VERSION}"
}

ensure_encryption_key() {
  if [[ -e "${ENCRYPTION_KEY_FILE}" ]]; then
    [[ -f "${ENCRYPTION_KEY_FILE}" && ! -L "${ENCRYPTION_KEY_FILE}" ]] || die "invalid encryption key path"
  else
    umask 077
    printf '%s' "$(openssl rand -hex 16)" > "${ENCRYPTION_KEY_FILE}"
  fi
  chmod 0600 "${ENCRYPTION_KEY_FILE}"
  [[ "$(wc -c < "${ENCRYPTION_KEY_FILE}")" == "32" ]] || die "encryption key must be exactly 32 hexadecimal characters"
}

install_zadig() {
  export KUBECONFIG="${KUBECONFIG_PATH}"
  helm repo add koderover-chart "${ZADIG_CHART_REPOSITORY}" --force-update
  helm repo update koderover-chart

  helm upgrade --install --create-namespace \
    --namespace "${ZADIG_NAMESPACE}" \
    --version "${ZADIG_VERSION}" \
    --timeout 60m \
    --set "global.extensions.extAuth.extauthzServerRef.namespace=${ZADIG_NAMESPACE}" \
    --set "gloo.gatewayProxies.gatewayProxy.service.type=NodePort" \
    --set "gloo.gatewayProxies.gatewayProxy.service.httpNodePort=${ZADIG_NODE_PORT}" \
    --set "endpoint.type=FQDN" \
    --set-string "endpoint.FQDN=${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}" \
    --set "connections.mongodb.db=zadig" \
    --set "ee.mongodb.db=plutus_zadig" \
    --set "tags.mongodb=true" \
    --set "mongodb.persistence.size=30Gi" \
    --set "tags.mysql=true" \
    --set "mysql.persistence.size=30Gi" \
    --set "tags.minio=true" \
    --set "minio.persistence.storageClass=local-path" \
    --set "dex.fullnameOverride=zadig-${ZADIG_NAMESPACE}-dex" \
    --set-string "dex.config.issuer=http://zadig-${ZADIG_NAMESPACE}-dex:5556/dex" \
    --set-string "dex.config.staticClients[0].redirectURIs[0]=http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}/api/v1/callback" \
    --set-string "dex.config.staticClients[0].id=zadig" \
    --set-string "dex.config.staticClients[0].name=zadig" \
    --set-string "dex.config.staticClients[0].secret=ZXhhbXBsZS1hcHAtc2VjcmV0" \
    --set-file "global.encryption.key=${ENCRYPTION_KEY_FILE}" \
    "${ZADIG_RELEASE_NAME}" koderover-chart/zadig

  log "Zadig Helm release installed"
}

create_ppe_slots() {
  export KUBECONFIG="${KUBECONFIG_PATH}"
  local index namespace
  for index in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
    namespace="${PPE_NAMESPACE_PREFIX}${index}"
    kubectl create namespace "${namespace}" --dry-run=client -o yaml | kubectl apply -f -
    kubectl label namespace "${namespace}" \
      multiremi.io/purpose=ppe \
      "multiremi.io/slot=${index}" \
      --overwrite
    # limits.memory must cover both build Jobs at once (6Gi API + 12Gi Web)
    # alongside the deployed stack; at 16Gi the Web build could not be given
    # the headroom it needs and was OOM-killed instead. See MUL-303.
    kubectl create resourcequota multiremi-ppe-budget \
      --namespace "${namespace}" \
      --hard=requests.cpu=6,requests.memory=12Gi,limits.cpu=12,limits.memory=32Gi,pods=30,persistentvolumeclaims=10,requests.storage=40Gi \
      --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply --namespace "${namespace}" -f - <<'YAML'
apiVersion: v1
kind: LimitRange
metadata:
  name: multiremi-ppe-defaults
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: 250m
        memory: 256Mi
      default:
        cpu: "2"
        memory: 2Gi
YAML
  done
  log "prepared ${PPE_MAX_ENVIRONMENTS} PPE namespaces"
}

configure_local_registry() {
  export KUBECONFIG="${KUBECONFIG_PATH}"
  local registry_host="${ZADIG_NODE_IP}:${PPE_REGISTRY_NODE_PORT}"
  local registry_config="/etc/rancher/k3s/registries.yaml"
  local desired_config
  desired_config="$(cat <<YAML
mirrors:
  "${registry_host}":
    endpoint:
      - "http://${registry_host}"
configs:
  "${registry_host}":
    tls:
      insecure_skip_verify: true
YAML
)"
  if [[ ! -f "${registry_config}" || "$(<"${registry_config}")" != "${desired_config}" ]]; then
    install -d -m 0755 /etc/rancher/k3s
    printf '%s\n' "${desired_config}" > "${registry_config}"
    chmod 0600 "${registry_config}"
    systemctl restart k3s
    for _ in $(seq 1 90); do
      if kubectl get node >/dev/null 2>&1 && [[ "$(kubectl get node -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')" == "True" ]]; then
        break
      fi
      sleep 2
    done
    [[ "$(kubectl get node -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')" == "True" ]] || die "k3s did not recover after registry configuration"
  fi

  kubectl create namespace "${PPE_REGISTRY_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
  cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: registry-data
  namespace: ${PPE_REGISTRY_NAMESPACE}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: ${PPE_REGISTRY_STORAGE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: registry
  namespace: ${PPE_REGISTRY_NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels: { app: registry }
  template:
    metadata:
      labels: { app: registry }
    spec:
      containers:
      - name: registry
        image: ${PPE_REGISTRY_IMAGE}
        ports: [{ containerPort: 5000 }]
        readinessProbe: { httpGet: { path: /v2/, port: 5000 }, initialDelaySeconds: 3, periodSeconds: 5 }
        resources:
          requests: { cpu: 100m, memory: 128Mi }
          limits: { cpu: "1", memory: 1Gi }
        volumeMounts: [{ name: data, mountPath: /var/lib/registry }]
      volumes: [{ name: data, persistentVolumeClaim: { claimName: registry-data } }]
---
apiVersion: v1
kind: Service
metadata:
  name: registry
  namespace: ${PPE_REGISTRY_NAMESPACE}
spec:
  type: NodePort
  selector: { app: registry }
  ports: [{ name: registry, port: 5000, targetPort: 5000, nodePort: ${PPE_REGISTRY_NODE_PORT} }]
YAML
  kubectl -n "${PPE_REGISTRY_NAMESPACE}" rollout status deployment/registry --timeout=5m
  curl --noproxy '*' -fsS "http://${registry_host}/v2/" >/dev/null
  log "PPE registry is ready at ${registry_host}"
}

grant_workflow_ppe_access() {
  export KUBECONFIG="${KUBECONFIG_PATH}"
  kubectl apply -f - <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: multiremi-ppe-workflow
rules:
- apiGroups: [""]
  resources: ["configmaps", "endpoints", "events", "pods", "pods/exec", "pods/log", "persistentvolumeclaims", "secrets", "services"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets", "statefulsets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
YAML
  local index namespace
  for index in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
    namespace="${PPE_NAMESPACE_PREFIX}${index}"
    cat <<YAML | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: multiremi-ppe-workflow
  namespace: ${namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: multiremi-ppe-workflow
subjects:
- kind: ServiceAccount
  name: workflow-cm-sa
  namespace: ${ZADIG_NAMESPACE}
YAML
  done
  log "restricted Zadig workflow access granted to PPE namespaces"
}

install_ppe_gc() {
  export KUBECONFIG="${KUBECONFIG_PATH}"

  kubectl -n "${ZADIG_NAMESPACE}" create configmap multiremi-ppe-gc-script \
    --from-file=gc.sh="${SCRIPT_DIR}/ppe/gc.sh" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl apply -f - <<YAML
apiVersion: v1
kind: ServiceAccount
metadata:
  name: multiremi-ppe-gc
  namespace: ${ZADIG_NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: multiremi-ppe-gc
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "create", "delete"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims", "secrets", "services"]
  verbs: ["get", "list", "delete", "deletecollection"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "delete", "deletecollection"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "delete", "deletecollection"]
YAML

  local index namespace
  for index in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
    namespace="${PPE_NAMESPACE_PREFIX}${index}"
    cat <<YAML | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: multiremi-ppe-gc
  namespace: ${namespace}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: multiremi-ppe-gc
subjects:
- kind: ServiceAccount
  name: multiremi-ppe-gc
  namespace: ${ZADIG_NAMESPACE}
YAML
  done

  cat <<YAML | kubectl apply -f -
apiVersion: batch/v1
kind: CronJob
metadata:
  name: multiremi-ppe-gc
  namespace: ${ZADIG_NAMESPACE}
spec:
  schedule: "${PPE_GC_SCHEDULE}"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      ttlSecondsAfterFinished: 3600
      backoffLimit: 1
      activeDeadlineSeconds: 240
      template:
        metadata:
          labels:
            multiremi.io/component: ppe-gc
        spec:
          serviceAccountName: multiremi-ppe-gc
          restartPolicy: Never
          containers:
          - name: gc
            image: ${PPE_GC_IMAGE}
            imagePullPolicy: IfNotPresent
            command: [bash, /opt/multiremi-ppe/gc.sh]
            env:
            - { name: PPE_NAMESPACE_PREFIX, value: "${PPE_NAMESPACE_PREFIX}" }
            - { name: PPE_MAX_ENVIRONMENTS, value: "${PPE_MAX_ENVIRONMENTS}" }
            - { name: PPE_WORKFLOW_LOCK_TTL_MINUTES, value: "${PPE_WORKFLOW_LOCK_TTL_MINUTES}" }
            - { name: PPE_GC_LOCK_TTL_MINUTES, value: "${PPE_GC_LOCK_TTL_MINUTES}" }
            resources:
              requests: { cpu: 25m, memory: 32Mi }
              limits: { cpu: 250m, memory: 128Mi }
            volumeMounts:
            - { name: script, mountPath: /opt/multiremi-ppe, readOnly: true }
          volumes:
          - name: script
            configMap:
              name: multiremi-ppe-gc-script
              defaultMode: 365
YAML
  log "installed 24-hour PPE TTL collector on ${PPE_GC_SCHEDULE}"
}

install_k3s
install_helm
ensure_encryption_key
install_zadig
"${SCRIPT_DIR}/configure-edge.sh"
create_ppe_slots
configure_local_registry
grant_workflow_ppe_access
install_ppe_gc
"${SCRIPT_DIR}/bootstrap.sh"
"${SCRIPT_DIR}/configure-ppe.sh"
"${SCRIPT_DIR}/verify.sh"

log "Zadig is available at http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}"
log "workflow and task concurrency are configured to ${PPE_BUILD_CONCURRENCY}"
