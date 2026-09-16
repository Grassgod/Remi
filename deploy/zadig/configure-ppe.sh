#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

SECRETS_DIR="${ZADIG_ROOT}/secrets"
ADMIN_API_TOKEN_FILE="${SECRETS_DIR}/admin-api-token"
ZADIG_URL="http://${ZADIG_NODE_IP}:${ZADIG_NODE_PORT}"
REGISTRY_HOST="${ZADIG_NODE_IP}:${PPE_REGISTRY_NODE_PORT}"
PROJECT_KEY="multiremi-ppe"
WORKFLOW_KEY="multiremi-ppe-deploy"
KUBECONFIG_PATH="/etc/rancher/k3s/k3s.yaml"

log() { printf '[zadig-ppe] %s\n' "$*"; }
die() { printf '[zadig-ppe] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run as root: sudo bash ${SCRIPT_DIR}/configure-ppe.sh"
[[ "${ZADIG_ROOT}" == /data00/multiremi/zadig ]] || die "unexpected ZADIG_ROOT: ${ZADIG_ROOT}"
[[ -s "${ADMIN_API_TOKEN_FILE}" ]] || die "administrator API token is missing"
[[ -r "${KUBECONFIG_PATH}" ]] || die "k3s kubeconfig is unavailable"

runtime_home="${HOME:?}"
cli_home="$(mktemp -d "${ZADIG_ROOT}/cli-home.XXXXXX")"
work_dir="$(mktemp -d "${ZADIG_ROOT}/configure-ppe.XXXXXX")"
trap 'find "${cli_home}" "${work_dir}" -xdev -depth -delete 2>/dev/null || true' EXIT
chmod 0700 "${cli_home}" "${work_dir}"

zadig_cli=(env HOME="${cli_home}" npm_config_cache="${runtime_home}/.npm" NO_PROXY="${NO_PROXY:-},${ZADIG_NODE_IP}" no_proxy="${no_proxy:-},${ZADIG_NODE_IP}"
  npx --yes --registry=https://registry.npmjs.org "${ZADIG_CLI_PACKAGE}")
admin_api_token="$(<"${ADMIN_API_TOKEN_FILE}")"
"${zadig_cli[@]}" auth login --host "${ZADIG_URL}" --token "${admin_api_token}" >/dev/null

cli_json() {
  "${zadig_cli[@]}" "$@" --output json
}

ensure_registry() {
  local registry_file registry_id http_code
  registry_file="${work_dir}/registries.json"
  cli_json registry list > "${registry_file}"
  registry_id="$(jq -r --arg address "http://${REGISTRY_HOST}" --arg namespace "${PPE_REGISTRY_NAME}" \
    '.data[]? | select(.address == $address and .namespace == $namespace) | .registry_id' "${registry_file}" | head -n 1)"
  if [[ -z "${registry_id}" ]]; then
    http_code="$(
      jq -n \
        --arg address "http://${REGISTRY_HOST}" \
        --arg namespace "${PPE_REGISTRY_NAME}" \
        '{address:$address,provider:"native",namespace:$namespace,is_default:false,access_key:"",secret_key:"",enable_tls:false}' |
        curl --noproxy '*' -sS -o "${work_dir}/registry-create.json" -w '%{http_code}' \
          -H 'Content-Type: application/json' \
          -H "Authorization: Bearer ${admin_api_token}" \
          --data-binary @- "${ZADIG_URL}/openapi/system/registry"
    )"
    [[ "${http_code}" == "200" || "${http_code}" == "201" ]] || die "registry registration failed with HTTP ${http_code}"
    cli_json registry list > "${registry_file}"
    registry_id="$(jq -r --arg address "http://${REGISTRY_HOST}" --arg namespace "${PPE_REGISTRY_NAME}" \
      '.data[]? | select(.address == $address and .namespace == $namespace) | .registry_id' "${registry_file}" | head -n 1)"
  fi
  [[ -n "${registry_id}" ]] || die "registered PPE registry could not be resolved"
  printf '%s' "${registry_id}"
}

ensure_project() {
  if cli_json project get "${PROJECT_KEY}" >/dev/null 2>&1; then
    return
  fi
  jq -n '{project_name:"Multiremi PPE",project_key:"multiremi-ppe",is_public:false,description:"QA-managed isolated Multiremi PPE environments; never production",project_type:"yaml"}' |
    "${zadig_cli[@]}" project create --file - --yes --output json >/dev/null
  log "created Zadig project ${PROJECT_KEY}"
}

ensure_environments() {
  local registry_id="$1" cluster_id environments_file index env_key namespace
  cluster_id="$(cli_json cluster list "${PROJECT_KEY}" | jq -r '.data[] | select(.local == true and .status == "normal") | .cluster_id' | head -n 1)"
  [[ -n "${cluster_id}" ]] || die "no healthy local Zadig cluster is available"
  environments_file="${work_dir}/environments.json"
  cli_json env list "${PROJECT_KEY}" > "${environments_file}"
  for index in $(seq 1 "${PPE_MAX_ENVIRONMENTS}"); do
    env_key="ppe-${index}"
    namespace="${PPE_NAMESPACE_PREFIX}${index}"
    if jq -e --arg key "${env_key}" '.data[]? | select(.env_key == $key)' "${environments_file}" >/dev/null; then
      continue
    fi
    jq -n \
      --arg env_key "${env_key}" \
      --arg cluster_id "${cluster_id}" \
      --arg namespace "${namespace}" \
      --arg registry_id "${registry_id}" \
      --arg env_name "PPE ${index}" \
      '{env_key:$env_key,cluster_id:$cluster_id,namespace:$namespace,registry_id:$registry_id,env_name:$env_name,sub_env:null,global_variables:[],services:[],env_configs:[]}' |
      "${zadig_cli[@]}" env create "${PROJECT_KEY}" --type yaml --file - --yes --output json >/dev/null
    log "registered ${env_key} on namespace ${namespace}"
  done
}

write_workflow_request() {
  local basic_image_id cluster_id workflow_script fake_acp_base64
  cluster_id="$(cli_json cluster list "${PROJECT_KEY}" | jq -r '.data[] | select(.local == true and .status == "normal") | .cluster_id' | head -n 1)"
  basic_image_id="$(curl --noproxy '*' -fsS \
    -H "Authorization: Bearer ${admin_api_token}" \
    "${ZADIG_URL}/api/aslan/system/basicImages?image_from=koderover" |
    jq -r '.[] | select(.value == "focal") | .id' | head -n 1)"
  [[ -n "${basic_image_id}" ]] || die "Zadig focal base image could not be resolved"
  workflow_script="$(<"${SCRIPT_DIR}/ppe/workflow.sh")"
  fake_acp_base64="$(base64 -w 0 "${SCRIPT_DIR}/ppe/fake-acp.ts")"
  jq -n \
    --arg project "${PROJECT_KEY}" \
    --arg script "${workflow_script}" \
    --arg cluster_id "${cluster_id}" \
    --arg basic_image_id "${basic_image_id}" \
    --arg kubectl_version "${PPE_KUBECTL_VERSION}" \
    --arg kubectl_sha256 "${PPE_KUBECTL_SHA256}" \
    --arg registry_host "${REGISTRY_HOST}" \
    --arg kaniko_image "${PPE_KANIKO_IMAGE}" \
    --arg fake_acp_base64 "${fake_acp_base64}" \
    --arg access_host "${ZADIG_NODE_IP}" \
    --arg max_environments "${PPE_MAX_ENVIRONMENTS}" \
    --arg ttl_hours "${PPE_TTL_HOURS}" \
    --arg allocation_lock_ttl_minutes "${PPE_ALLOCATION_LOCK_TTL_MINUTES}" \
    --arg workflow_lock_ttl_minutes "${PPE_WORKFLOW_LOCK_TTL_MINUTES}" \
    --arg gc_lock_ttl_minutes "${PPE_GC_LOCK_TTL_MINUTES}" \
    '{
      name:"multiremi-ppe-deploy",
      display_name:"Multiremi PPE 构建、部署与释放",
      project:$project,
      description:"按 Issue 自动租用 24 小时隔离 PPE；支持纯平台和平台加测试 daemon。",
      disabled:false,
      category:"",
      concurrency_limit:-1,
      params:[
        {name:"PPE_ACTION",description:"部署、续期、释放或查看状态",type:"choice",value:"deploy",default:"deploy",choice_option:["deploy","extend","release","status"],choice_value:["deploy"],is_credential:false,source:"runtime",required:true},
        {name:"PPE_SLOT",description:"自动分配；仅管理员排障时指定 1-6",type:"choice",value:"auto",default:"auto",choice_option:["auto","1","2","3","4","5","6"],choice_value:["auto"],is_credential:false,source:"runtime",required:true},
        {name:"ISSUE_KEY",description:"PPE 所属 Multiremi Issue，例如 MUL-123",type:"string",value:"",default:"",is_credential:false,source:"runtime",required:false},
        {name:"PPE_LEASE_ID",description:"续期或释放时使用的租约 ID",type:"string",value:"",default:"",is_credential:false,source:"runtime",required:false},
        {name:"GIT_COMMIT",description:"Grassgod/Remi 的完整 40 位 Commit SHA",type:"string",value:"",default:"",is_credential:false,source:"runtime",required:false},
        {name:"PPE_MODE",description:"纯平台或平台加隔离 daemon",type:"choice",value:"platform",default:"platform",choice_option:["platform","platform-daemon"],choice_value:["platform"],is_credential:false,source:"runtime",required:false}
      ],
      stages:[{
        name:"构建与部署",
        parallel:false,
        approval:null,
        manual_exec:null,
        jobs:[{
          name:"ppe-lifecycle",
          type:"freestyle",
          skipped:false,
          run_policy:"",
          error_policy:null,
          execute_policy:null,
          spec:{
            freestyle_type:"",
            source:"runtime",
            ref_repos:false,
            repos:[],
            envs:[
              {key:"PPE_KUBECTL_VERSION",value:$kubectl_version,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_KUBECTL_SHA256",value:$kubectl_sha256,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_REGISTRY_HOST",value:$registry_host,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_KANIKO_IMAGE",value:$kaniko_image,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_FAKE_ACP_BASE64",value:$fake_acp_base64,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_ACCESS_HOST",value:$access_host,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_MAX_ENVIRONMENTS",value:$max_environments,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_TTL_HOURS",value:$ttl_hours,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_ALLOCATION_LOCK_TTL_MINUTES",value:$allocation_lock_ttl_minutes,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_WORKFLOW_LOCK_TTL_MINUTES",value:$workflow_lock_ttl_minutes,type:"string",is_credential:false,source:"fixed"},
              {key:"PPE_GC_LOCK_TTL_MINUTES",value:$gc_lock_ttl_minutes,type:"string",is_credential:false,source:"fixed"}
            ],
            script:$script,
            script_type:"shell",
            object_storage_upload:{enabled:false},
            default_services:[],
            services:[],
            runtime:{infrastructure:"kubernetes",build_os:"focal",image_from:"koderover",image_id:$basic_image_id,installs:[],vm_labels:[]},
            advanced_setting:{timeout:90,cluster_id:$cluster_id,cluster_source:"",res_req:"min",res_req_spec:{cpu_limit:2000,memory_limit:2048,cpu_req:500,memory_req:512,gpu_limit:""},strategy_id:"",use_host_docker_daemon:false,custom_annotations:[],custom_labels:[],share_storage_info:{},outputs:[]}
          }
        }]
      }],
      notify_ctls:[],
      share_storages:[],
      remark_required:false,
      ignore_cache:false
    }' > "${work_dir}/workflow.json"
}

ensure_workflow() {
  local response_file
  response_file="${work_dir}/workflow-response.json"
  write_workflow_request
  if ! "${zadig_cli[@]}" workflow create "${PROJECT_KEY}" --file "${work_dir}/workflow.json" --dry-run --output json > "${response_file}"; then
    die "workflow dry-run failed: $(jq -r '.error.type + "/" + .error.subtype + ": " + .error.message' "${response_file}" 2>/dev/null || printf 'invalid CLI response')"
  fi
  if cli_json workflow get "${WORKFLOW_KEY}" "${PROJECT_KEY}" >/dev/null 2>&1; then
    if ! "${zadig_cli[@]}" workflow update "${WORKFLOW_KEY}" "${PROJECT_KEY}" --file "${work_dir}/workflow.json" --yes --output json > "${response_file}"; then
      die "workflow update failed: $(jq -r '.error.type + "/" + .error.subtype + ": " + .error.message' "${response_file}" 2>/dev/null || printf 'invalid CLI response')"
    fi
    log "updated workflow ${WORKFLOW_KEY}"
  else
    if ! "${zadig_cli[@]}" workflow create "${PROJECT_KEY}" --file "${work_dir}/workflow.json" --yes --output json > "${response_file}"; then
      die "workflow create failed: $(jq -r '.error.type + "/" + .error.subtype + ": " + .error.message' "${response_file}" 2>/dev/null || printf 'invalid CLI response')"
    fi
    log "created workflow ${WORKFLOW_KEY}"
  fi
}

ensure_qa_permissions() {
  local qa_uid roles_file role_request binding_request
  qa_uid="$(cli_json user list --page 1 --page-size 20 --account "${ZADIG_QA_USERNAME}" | jq -r --arg account "${ZADIG_QA_USERNAME}" '.data.users[]? | select(.account == $account) | .uid' | head -n 1)"
  [[ -n "${qa_uid}" ]] || die "QA user ${ZADIG_QA_USERNAME} does not exist"
  role_request="${work_dir}/qa-role.json"
  binding_request="${work_dir}/qa-binding.json"
  jq -n '{name:"ppe-qa",actions:["get_workflow","run_workflow","get_environment","get_service","get_build","debug_pod"],desc:"Run and inspect isolated Multiremi PPE only",type:"",global_read_only:false}' > "${role_request}"
  roles_file="${work_dir}/roles.json"
  cli_json policy role list "${PROJECT_KEY}" > "${roles_file}"
  if jq -e '.data[]? | select(.name == "ppe-qa")' "${roles_file}" >/dev/null; then
    "${zadig_cli[@]}" policy role update ppe-qa "${PROJECT_KEY}" --file "${role_request}" --yes --output json >/dev/null
  else
    "${zadig_cli[@]}" policy role create "${PROJECT_KEY}" --file "${role_request}" --yes --output json >/dev/null
  fi
  jq -n --arg uid "${qa_uid}" '{identities:[{identity_type:"user",uid:$uid}],role:"ppe-qa"}' > "${binding_request}"
  "${zadig_cli[@]}" policy binding apply "${PROJECT_KEY}" --file "${binding_request}" --yes --output json >/dev/null
  log "bound ${ZADIG_QA_USERNAME} to project-scoped ppe-qa permissions"
}

registry_id="$(ensure_registry)"
ensure_project
ensure_environments "${registry_id}"
ensure_workflow
ensure_qa_permissions
log "PPE project, environments, workflow, and QA permissions are ready"
